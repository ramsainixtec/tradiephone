#!/usr/bin/env node
/**
 * white-label — rebrand this project end to end.
 *
 *     npx white-label from: oldbrand to: bright plumbing
 *
 * Sweeps every text file in the repo and swaps the product label wherever it
 * appears: identifiers, storage keys, package names, domains, e-mail addresses,
 * file names and the prose users actually read. Each occurrence is rewritten in
 * the casing it was found in, so `OLDBRAND_TOKEN` stays a constant and
 * "Welcome to Oldbrand" stays a sentence.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { analyze, slugWarnings } from "./lib/naming.mjs";
import { countBrand, rewriteBasename, rewriteContents } from "./lib/rewrite.mjs";
import {
  CONFIG_FILE,
  DEFAULT_SKIP_DIRS,
  DEFAULT_SKIP_FILES,
  DEFAULT_SLUG_ONLY_FILES,
  VERIFY_SKIP_DIRS,
  collectFiles,
  collectPaths,
  findRoot,
  gitStatus,
  isSlugOnly,
  loadConfig,
  readTextFile,
  saveConfig,
  writeTextFile,
} from "./lib/project.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));

const paint = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = "\u001b[";
const style = (code, text) => (paint ? `${ESC}${code}m${text}${ESC}0m` : text);
const bold = (text) => style("1", text);
const dim = (text) => style("2", text);
const green = (text) => style("32", text);
const yellow = (text) => style("33", text);
const red = (text) => style("31", text);
const cyan = (text) => style("36", text);

const USAGE = `
${bold("white-label")} — swap this project's brand everywhere it appears.

${bold("Usage")}
  npx white-label from: <old label> to: <new label> [options]
  npx white-label to: <new label>                 ${dim("# reuses the brand recorded in " + CONFIG_FILE)}

${bold("Options")}
  from: <label>      Brand to replace. Optional once ${CONFIG_FILE} exists.
  to: <label>        New brand. Multi-word labels are fine: ${dim("to: bright plumbing")}
  display: <text>    Pin the human-readable name ${dim("(default: Title Case of `to`)")}
  slug: <text>       Pin the identifier form used for packages, keys and domains
                     ${dim("(default: the words squashed together, e.g. brightplumbing)")}
  domain: <host>     Pin the new domain, TLD included ${dim("(default: <slug> + the old TLD)")}
  --dry-run, -n      Show what would change without writing anything
  --allow-dirty      Run even with uncommitted changes
  --no-locks         Leave package-lock.json and friends untouched
  --no-rename        Do not rename files or directories
  --no-config        Do not write ${CONFIG_FILE}
  --quiet            Only print the summary
  --help, -h         Show this message

${bold("Examples")}
  npx white-label from: oldbrand to: bright plumbing
  npx white-label from: oldbrand to: bright plumbing domain: brightplumbing.com.au
  npx white-label to: acme voice slug: acme-voice --dry-run
`;

function fail(message) {
  process.stderr.write(`${red("white-label:")} ${message}\n`);
  process.exit(1);
}

/**
 * The old domain, so its TLD can be carried over to the new one. Read from the
 * config when present, otherwise inferred from whatever the repo already uses.
 */
function detectDomain(root, source, configured) {
  if (configured) return configured;
  const alt = source.patterns.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(?:${alt})((?:\\.[a-z]{2,24}){1,2})`, "gi");
  const tally = new Map();
  const { files } = collectFiles(root, { includeLocks: false });
  for (const relative of files.slice(0, 4000)) {
    let text;
    try {
      text = readTextFile(root, relative);
    } catch {
      continue;
    }
    if (!text) continue;
    for (const match of text.matchAll(re)) {
      const tld = match[1].toLowerCase();
      tally.set(tld, (tally.get(tld) ?? 0) + 1);
    }
  }
  const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? `${source.slug}${best[0]}` : null;
}

/**
 * Sweep the repo once more — build output and skipped directories included —
 * for anything still carrying the old brand. This is the check that makes
 * handing the repo to another business safe.
 */
function findLeftovers(root, source) {
  const { files } = collectFiles(root, { skipDirs: VERIFY_SKIP_DIRS, skipFiles: [] });
  const leftovers = [];
  for (const relative of files) {
    let text;
    try {
      text = readTextFile(root, relative);
    } catch {
      continue;
    }
    if (!text) continue;
    const count = countBrand(text, source);
    if (count) leftovers.push({ relative, count });
  }
  return leftovers.sort((a, b) => b.count - a.count);
}

/** A compact before/after excerpt for one changed line. */
function sampleDiff(before, after, limit) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const samples = [];
  for (let i = 0; i < beforeLines.length && samples.length < limit; i += 1) {
    if (beforeLines[i] === afterLines[i]) continue;
    samples.push({
      line: i + 1,
      before: beforeLines[i].trim().slice(0, 120),
      after: (afterLines[i] ?? "").trim().slice(0, 120),
    });
  }
  return samples;
}

function main(argv) {
  const { values, flags, unknown } = parseArgs(argv);

  if (flags.has("help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (flags.has("version")) {
    process.stdout.write(`${PKG.version}\n`);
    return;
  }
  if (unknown.length) fail(`unknown option ${unknown[0]} — run with --help to see what is supported.`);

  const root = values.root ? path.resolve(values.root) : findRoot(process.cwd());
  const config = loadConfig(root);
  const dryRun = flags.has("dry-run");
  const quiet = flags.has("quiet");

  const fromLabel = values.from || config.brand?.name;
  if (!fromLabel) {
    fail(
      `nothing to rename from. Pass ${cyan("from: <old label>")}, or run this once with from: so ` +
        `${CONFIG_FILE} can remember the current brand.`,
    );
  }
  if (!values.to) fail(`nothing to rename to. Pass ${cyan("to: <new label>")}. See --help for examples.`);

  // The recorded display/slug/domain describe the brand named in the config.
  // They only apply when that is the brand being replaced — passing a different
  // `from:` must derive its variants from the label itself, or the source
  // patterns would describe the wrong brand entirely.
  const configBrand = (config.brand?.name ?? "").trim().toLowerCase();
  const usesConfigBrand = !values.from || values.from.trim().toLowerCase() === configBrand;
  const sourceHints = usesConfigBrand
    ? { display: config.brand?.display, slug: config.brand?.slug }
    : {};

  const source = analyze(fromLabel, sourceHints);
  const target = analyze(values.to, { display: values.display, slug: values.slug });

  if (source.slug === target.slug && source.display === target.display) {
    fail(`"${fromLabel}" and "${values.to}" produce the same brand — nothing to do.`);
  }

  for (const warning of slugWarnings(target.slug)) {
    process.stderr.write(`${yellow("warning:")} ${warning}\n`);
  }

  const fromDomain = detectDomain(root, source, usesConfigBrand ? config.brand?.domain : undefined);
  const defaultToDomain = fromDomain
    ? fromDomain.replace(new RegExp(`^${source.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), target.slug)
    : null;
  const toDomain = values.domain || defaultToDomain;
  // The generic pass already handles a same-TLD swap; only run the domain pass
  // when the host genuinely differs (a new TLD, or an explicit `domain:`).
  const domainPass = toDomain && toDomain !== defaultToDomain ? toDomain : null;

  const git = gitStatus(root);
  if (git.isRepo && git.dirty && !dryRun && !flags.has("allow-dirty")) {
    fail(
      `the working tree has uncommitted changes. Commit or stash them first so this sweep can be undone ` +
        `with ${cyan("git restore .")}, or re-run with ${cyan("--allow-dirty")}.`,
    );
  }

  const skipDirs = config.skipDirs ?? DEFAULT_SKIP_DIRS;
  const skipFiles = config.skipFiles ?? DEFAULT_SKIP_FILES;
  const slugOnlyFiles = config.slugOnlyFiles ?? DEFAULT_SLUG_ONLY_FILES;

  const plan = {
    source,
    target,
    toDomain: domainPass,
    overrides: config.overrides ?? {},
  };

  if (!quiet) {
    process.stdout.write(`\n${bold("white-label")} ${dim(`· ${root}`)}\n`);
    process.stdout.write(`  ${dim("from")}  ${source.display} ${dim(`(${source.slug})`)}\n`);
    process.stdout.write(`  ${dim("to")}    ${bold(target.display)} ${dim(`(${target.slug})`)}\n`);
    if (fromDomain || toDomain) {
      process.stdout.write(`  ${dim("domain")} ${fromDomain ?? dim("—")} ${dim("→")} ${toDomain ?? dim("—")}\n`);
    }
    if (dryRun) process.stdout.write(`  ${yellow("dry run — no files will be written")}\n`);
    process.stdout.write("\n");
  }

  const { files, skipped } = collectFiles(root, {
    skipDirs,
    skipFiles,
    includeLocks: !flags.has("no-locks"),
  });

  const changes = [];
  let replacements = 0;

  for (const relative of files) {
    let text;
    try {
      text = readTextFile(root, relative);
    } catch (error) {
      process.stderr.write(`${yellow("warning:")} could not read ${relative} — ${error.message}\n`);
      continue;
    }
    if (text === null) continue;

    const result = rewriteContents(text, plan, { slugOnly: isSlugOnly(relative, slugOnlyFiles) });
    if (!result.changed) continue;

    changes.push({ relative, count: result.count, samples: sampleDiff(text, result.text, 2) });
    replacements += result.count;
    if (!dryRun) writeTextFile(root, relative, result.text);
  }

  // Renames come last: contents are rewritten while paths are still stable.
  const renames = [];
  if (!flags.has("no-rename")) {
    for (const entry of collectPaths(root, { skipDirs })) {
      const renamed = rewriteBasename(entry.name, plan);
      if (renamed === entry.name) continue;
      const parent = path.dirname(entry.relative);
      const nextRelative = parent === "." ? renamed : `${parent}/${renamed}`;
      renames.push({ from: entry.relative, to: nextRelative });
      if (!dryRun) {
        try {
          fs.renameSync(path.join(root, entry.relative), path.join(root, nextRelative));
        } catch (error) {
          process.stderr.write(`${yellow("warning:")} could not rename ${entry.relative} — ${error.message}\n`);
        }
      }
    }
  }

  if (!quiet && changes.length) {
    const width = Math.max(...changes.map((c) => c.relative.length));
    for (const change of changes) {
      process.stdout.write(
        `  ${green("✔")} ${change.relative.padEnd(width)}  ${dim(`${change.count}×`)}\n`,
      );
      for (const sample of change.samples) {
        process.stdout.write(`      ${dim(`${sample.line}:`)} ${red(`- ${sample.before}`)}\n`);
        process.stdout.write(`      ${dim(`${String(sample.line).replace(/./g, " ")} `)}${green(`+ ${sample.after}`)}\n`);
      }
    }
    process.stdout.write("\n");
  }

  if (!quiet && renames.length) {
    process.stdout.write(`  ${bold("Renamed")}\n`);
    for (const rename of renames) process.stdout.write(`  ${green("✔")} ${rename.from} ${dim("→")} ${rename.to}\n`);
    process.stdout.write("\n");
  }

  let configPath = null;
  if (!dryRun && !flags.has("no-config") && (changes.length || renames.length)) {
    // A run that could not detect a domain must not erase one already on
    // record — carry it forward through the same rewrite the files just had,
    // or repeated rebrandings would quietly lose it.
    const carriedDomain = config.brand?.domain
      ? rewriteContents(config.brand.domain, plan, { slugOnly: true }).text
      : null;
    const recordedDomain = toDomain || carriedDomain;

    configPath = saveConfig(root, {
      ...config,
      brand: {
        name: target.raw,
        display: target.display,
        slug: target.slug,
        ...(recordedDomain ? { domain: recordedDomain } : {}),
      },
    });
  }

  const verb = dryRun ? "would change" : "changed";
  process.stdout.write(
    `${bold(dryRun ? yellow("Dry run") : green("Done"))}  ${replacements} replacement${
      replacements === 1 ? "" : "s"
    } across ${changes.length} file${changes.length === 1 ? "" : "s"}${
      renames.length ? `, ${renames.length} path${renames.length === 1 ? "" : "s"} renamed` : ""
    } ${dim(`(${files.length} files scanned, ${verb})`)}\n`,
  );

  if (skipped.binary.length || skipped.oversized.length || skipped.locks.length) {
    const notes = [];
    if (skipped.binary.length) notes.push(`${skipped.binary.length} binary`);
    if (skipped.oversized.length) notes.push(`${skipped.oversized.length} oversized`);
    if (skipped.locks.length) notes.push(`${skipped.locks.length} lock file`);
    process.stdout.write(`${dim(`Skipped: ${notes.join(", ")}.`)}\n`);
  }

  if (configPath) {
    process.stdout.write(`${dim(`Recorded the new brand in ${CONFIG_FILE} — future runs can omit from:.`)}\n`);
  }

  if (!dryRun) {
    const leftovers = findLeftovers(root, source);
    if (!leftovers.length) {
      process.stdout.write(`${green("✔")} Verified: no trace of "${source.display}" left in the repo.\n`);
    } else {
      const total = leftovers.reduce((sum, item) => sum + item.count, 0);
      process.stdout.write(
        `\n${yellow("⚠")} ${total} mention${total === 1 ? "" : "s"} of "${source.display}" still present ` +
          `in ${leftovers.length} file${leftovers.length === 1 ? "" : "s"}:\n`,
      );
      for (const item of leftovers.slice(0, 15)) {
        process.stdout.write(`    ${item.relative} ${dim(`${item.count}×`)}\n`);
      }
      if (leftovers.length > 15) {
        process.stdout.write(`    ${dim(`…and ${leftovers.length - 15} more`)}\n`);
      }
      process.stdout.write(
        `${dim("  Build output is regenerated by the next build; anything else needs a look.")}\n`,
      );
    }
  }

  if (!dryRun && (changes.length || renames.length)) {
    process.stdout.write(
      `\n${bold("Next")}  review with ${cyan("git diff")}, then reinstall so package names resolve:\n` +
        `      ${cyan("npm install")} ${dim("&&")} ${cyan("npm --prefix server install")}\n`,
    );
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  fail(error.message);
}
