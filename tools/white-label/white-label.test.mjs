import { describe, expect, it } from "vitest";

import { parseArgs } from "./lib/args.mjs";
import { analyze, render, splitWords } from "./lib/naming.mjs";
import {
  countBrand,
  detectForm,
  rewriteBasename,
  rewriteBrand,
  rewriteContents,
} from "./lib/rewrite.mjs";
import {
  DEFAULT_SKIP_DIRS,
  DEFAULT_SKIP_FILES,
  DEFAULT_SLUG_ONLY_FILES,
  VERIFY_SKIP_DIRS,
  isSlugOnly,
} from "./lib/project.mjs";

/*
 * Fixtures use a stand-in brand rather than any real one, so this tool carries
 * no previous customer's name when the repo is handed on. `acme22` mirrors the
 * awkward shape that matters — a lowercase word with a digit suffix, spelled a
 * dozen different ways across a codebase.
 */
const source = analyze("acme22");
const target = analyze("bright plumbing");
const plan = { source, target, overrides: {} };

/** Rewrite `text` the way the CLI would for a normal source file. */
const swap = (text, options) => rewriteContents(text, plan, options).text;

describe("parseArgs", () => {
  it("reads the sentence form the command is documented with", () => {
    const { values } = parseArgs(["from:", "acme22", "to:", "bright", "plumbing"]);
    expect(values).toEqual({ from: "acme22", to: "bright plumbing" });
  });

  it("accepts values attached to their key", () => {
    const { values } = parseArgs(["from:acme22", "to:bright", "plumbing"]);
    expect(values).toEqual({ from: "acme22", to: "bright plumbing" });
  });

  it("accepts conventional flags too", () => {
    const { values, flags } = parseArgs(["--from=acme22", "--to", "bright plumbing", "--dry-run"]);
    expect(values).toEqual({ from: "acme22", to: "bright plumbing" });
    expect(flags.has("dry-run")).toBe(true);
  });

  it("stops a multi-word value at the next key", () => {
    const { values } = parseArgs(["to:", "bright", "plumbing", "domain:", "brightplumbing.com.au"]);
    expect(values.to).toBe("bright plumbing");
    expect(values.domain).toBe("brightplumbing.com.au");
  });

  it("collects unknown options instead of silently ignoring them", () => {
    expect(parseArgs(["--frm=x"]).unknown).toEqual(["--frm=x"]);
  });
});

describe("analyze", () => {
  it("derives every casing from a multi-word label", () => {
    expect(target).toMatchObject({
      display: "Bright Plumbing",
      slug: "brightplumbing",
      pascal: "BrightPlumbing",
      camel: "brightPlumbing",
      kebab: "bright-plumbing",
      snake: "bright_plumbing",
      constant: "BRIGHT_PLUMBING",
      upper: "BRIGHTPLUMBING",
    });
  });

  it("title-cases an all-lowercase label but respects deliberate casing", () => {
    expect(analyze("bright plumbing").display).toBe("Bright Plumbing");
    expect(analyze("brightPlumbing").display).toBe("brightPlumbing");
    expect(analyze("acme22").display).toBe("Acme22");
  });

  it("honours pinned display and slug overrides", () => {
    const pinned = analyze("bright plumbing", { display: "BrightPlumbing™", slug: "bright-plumbing" });
    expect(pinned.display).toBe("BrightPlumbing™");
    expect(pinned.slug).toBe("bright-plumbing");
  });

  it("splits camelCase and acronym boundaries", () => {
    expect(splitWords("brightPlumbingAPIClient")).toEqual(["bright", "Plumbing", "API", "Client"]);
    expect(splitWords("acme22")).toEqual(["acme22"]);
  });

  it("rejects a label with nothing to work with", () => {
    expect(() => analyze("   ")).toThrow(/no letters or digits/);
  });
});

describe("detectForm", () => {
  it("reads the shape of the matched text", () => {
    expect(detectForm("ACME22_TOKEN")).toBe("constant");
    expect(detectForm("bright-plumbing")).toBe("kebab");
    expect(detectForm("bright_plumbing")).toBe("snake");
    expect(detectForm("Bright Plumbing")).toBe("display");
    expect(detectForm("BrightPlumbing")).toBe("pascal");
    expect(detectForm("brightPlumbing")).toBe("camel");
  });
});

describe("prose vs code", () => {
  it("writes the display name in a sentence", () => {
    expect(swap("This is a test call summary from acme22. If you received this")).toBe(
      "This is a test call summary from Bright Plumbing. If you received this",
    );
  });

  it("writes the display name inside markup and quotes", () => {
    expect(swap('<span className="font-semibold">acme22</span>')).toBe(
      '<span className="font-semibold">Bright Plumbing</span>',
    );
    expect(swap('app_name: "Acme22"')).toBe('app_name: "Bright Plumbing"');
    expect(swap('"short_name": "acme22"')).toBe('"short_name": "Bright Plumbing"');
  });

  it("writes the slug inside domains, e-mails and URLs", () => {
    expect(swap("acme22.ai — Voice Receptionist")).toBe("brightplumbing.ai — Voice Receptionist");
    expect(swap("support@acme22.ai")).toBe("support@brightplumbing.ai");
    expect(swap("https://agent.acme22.ai/c/Xa7bK2p9")).toBe("https://agent.brightplumbing.ai/c/Xa7bK2p9");
    expect(swap("var PROD_HOSTS = ['acme22.ai', 'www.acme22.ai', 'app.acme22.ai'];")).toBe(
      "var PROD_HOSTS = ['brightplumbing.ai', 'www.brightplumbing.ai', 'app.brightplumbing.ai'];",
    );
  });

  it("writes the slug inside storage keys and identifiers", () => {
    expect(swap('export const TOKEN_KEY = "acme22_token";')).toBe(
      'export const TOKEN_KEY = "brightplumbing_token";',
    );
    expect(swap('const RELOAD_FLAG = "acme22:chunk-reloaded";')).toBe(
      'const RELOAD_FLAG = "brightplumbing:chunk-reloaded";',
    );
    expect(swap('name: "acme22_summary_channels"')).toBe('name: "brightplumbing_summary_channels"');
    expect(swap("postgresql://USER:PASSWORD@HOST:5432/acme22?schema=public")).toBe(
      "postgresql://USER:PASSWORD@HOST:5432/brightplumbing?schema=public",
    );
  });

  it("keeps a split word-mark reading as a domain", () => {
    expect(swap('acme22<span className="text-primary">.ai</span>')).toBe(
      'brightplumbing<span className="text-primary">.ai</span>',
    );
  });

  it("preserves SCREAMING_SNAKE and camelCase neighbours", () => {
    expect(swap("ACME22_TOKEN")).toBe("BRIGHTPLUMBING_TOKEN");
    expect(swap("appAcme22Logo")).toBe("appBrightPlumbingLogo");
  });

  it("never rewrites the middle of an unrelated word", () => {
    expect(swap("sacme22x")).toBe("sacme22x");
    expect(swap("theacme22nd")).toBe("theacme22nd");
  });
});

describe("dotfiles and tool config are in scope", () => {
  it("does not skip .gitignore, .claude or any other dotfile", () => {
    for (const entry of [".gitignore", ".claude", ".github", ".env", ".npmrc"]) {
      expect(DEFAULT_SKIP_DIRS).not.toContain(entry);
      expect(DEFAULT_SKIP_FILES).not.toContain(entry);
    }
  });

  it("rewrites a Claude permission entry carrying the old brand", () => {
    expect(swap('"Read(//e/VSCode/Acme22-AI-Dev/**)"')).toBe('"Read(//e/VSCode/BrightPlumbing-AI-Dev/**)"');
  });

  it("rewrites a .gitignore line carrying the old brand", () => {
    expect(swap("acme22-local.log\n!acme22.config.js")).toBe(
      "brightplumbing-local.log\n!brightplumbing.config.js",
    );
  });

  it("treats .env files as identifier-only so values stay machine-readable", () => {
    expect(isSlugOnly(".env", DEFAULT_SLUG_ONLY_FILES)).toBe(true);
    expect(isSlugOnly("server/.env.example", DEFAULT_SLUG_ONLY_FILES)).toBe(true);
    expect(isSlugOnly("src/lib/env.ts", DEFAULT_SLUG_ONLY_FILES)).toBe(false);
  });
});

describe("slug-only files", () => {
  it("keeps package.json names valid instead of writing a display name", () => {
    const packageJson = [
      '{ "name": "acme22",',
      '  "description": "Express + Prisma API for acme22.ai",',
      '  "dependencies": { "acme22": "file:.." } }',
    ].join("\n");
    expect(swap(packageJson, { slugOnly: true })).toBe(
      [
        '{ "name": "brightplumbing",',
        '  "description": "Express + Prisma API for brightplumbing.ai",',
        '  "dependencies": { "brightplumbing": "file:.." } }',
      ].join("\n"),
    );
  });

  it("rewrites a scoped package name", () => {
    expect(swap('"name": "acme22-server"', { slugOnly: true })).toBe('"name": "brightplumbing-server"');
  });
});

describe("domain pass", () => {
  const withDomain = { ...plan, toDomain: "brightplumbing.com.au" };

  it("swaps the whole host so the TLD can change, keeping the subdomain", () => {
    expect(rewriteContents("https://app.acme22.ai/login", withDomain).text).toBe(
      "https://app.brightplumbing.com.au/login",
    );
    expect(rewriteContents("support@acme22.ai", withDomain).text).toBe("support@brightplumbing.com.au");
  });

  it("leaves non-domain occurrences to the normal pass", () => {
    expect(rewriteContents('"acme22_token"', withDomain).text).toBe('"brightplumbing_token"');
    expect(rewriteContents("a summary from acme22.", withDomain).text).toBe(
      "a summary from Bright Plumbing.",
    );
  });

  it("does not treat a longer word ending in the brand as a host", () => {
    expect(rewriteContents("theacme22.ai", withDomain).text).toBe("theacme22.ai");
  });
});

describe("overrides", () => {
  it("take precedence over every derived rule", () => {
    const withOverride = { ...plan, overrides: { "support@acme22.ai": "help@brightplumbing.com.au" } };
    expect(rewriteContents("Contact support@acme22.ai today", withOverride).text).toBe(
      "Contact help@brightplumbing.com.au today",
    );
  });
});

describe("file names", () => {
  it("renames paths in identifier form", () => {
    expect(rewriteBasename("acme22-call.wav", plan)).toBe("brightplumbing-call.wav");
    expect(rewriteBasename("Acme22Logo.tsx", plan)).toBe("BrightPlumbingLogo.tsx");
    expect(rewriteBasename("unrelated.ts", plan)).toBe("unrelated.ts");
  });
});

describe("round trip", () => {
  it("renames back to the original brand", () => {
    const back = { source: target, target: analyze("acme22"), overrides: {} };
    const renamed = swap('const TOKEN_KEY = "acme22_token"; // acme22 is great');
    expect(renamed).toBe('const TOKEN_KEY = "brightplumbing_token"; // Bright Plumbing is great');
    expect(rewriteContents(renamed, back).text).toBe(
      'const TOKEN_KEY = "acme22_token"; // Acme22 is great',
    );
  });

  it("does not rescan text it has just written", () => {
    const widening = { source: analyze("acme"), target: analyze("acme voice"), overrides: {} };
    expect(rewriteContents("Welcome to acme", widening).text).toBe("Welcome to Acme Voice");
  });
});

describe("countBrand", () => {
  it("counts what the post-run verification would flag", () => {
    expect(countBrand('acme22.ai "acme22_token" ACME22', source)).toBe(3);
    expect(countBrand("nothing to see here", source)).toBe(0);
  });

  it("uses the same word boundaries as the rewriter, so near-misses do not count", () => {
    expect(countBrand("sacme22x theacme22nd", source)).toBe(0);
  });

  it("reports zero once a rewrite has run", () => {
    expect(countBrand(swap('acme22.ai "acme22_token" from acme22.'), source)).toBe(0);
  });

  it("still scans build output and tool config, which the rewrite pass skips", () => {
    expect(VERIFY_SKIP_DIRS).not.toContain("dist");
    expect(VERIFY_SKIP_DIRS).not.toContain(".claude");
    expect(VERIFY_SKIP_DIRS).toContain(".git");
    expect(VERIFY_SKIP_DIRS).toContain("node_modules");
  });
});

describe("render", () => {
  it("maps every form to a spelling", () => {
    expect(render("constant", target)).toBe("BRIGHT_PLUMBING");
    expect(render("displayUpper", target)).toBe("BRIGHT PLUMBING");
    expect(render("kebabUpper", target)).toBe("BRIGHT-PLUMBING");
  });
});

describe("rewriteBrand", () => {
  it("reports how many occurrences it touched", () => {
    const { count } = rewriteBrand("acme22 acme22.ai ACME22_KEY", source, target);
    expect(count).toBe(3);
  });
});
