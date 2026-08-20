/**
 * The rewriter.
 *
 * Finding the old brand is easy; deciding what to *replace it with* is the
 * whole problem. `oldbrand` inside `oldbrand_token` must become an identifier
 * (`brightplumbing_token`), while those very same characters inside "a summary
 * from oldbrand." must become prose ("a summary from Bright Plumbing.").
 *
 * So every match is classified twice: by the *shape* of the matched text
 * (SCREAMING_SNAKE stays screaming) and, when the shape is ambiguous, by the
 * *characters either side of it* — which is what separates a domain, a key or a
 * path from an English sentence.
 */

import { render } from "./naming.mjs";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Shape of the literal text that matched, before surroundings are considered. */
export function detectForm(matched) {
  if (/\s/.test(matched)) return matched === matched.toUpperCase() ? "displayUpper" : "display";
  if (matched.includes("-")) return /[a-z]/.test(matched) ? "kebab" : "kebabUpper";
  if (matched.includes("_")) return /[a-z]/.test(matched) ? "snake" : "constant";
  if (/[A-Z]/.test(matched) && matched === matched.toUpperCase()) return "ambiguousUpper";
  if (matched === matched.toLowerCase()) return "ambiguousLower";
  if (/^[A-Z][a-z0-9]*$/.test(matched)) return "ambiguousTitle";
  return /^[A-Z]/.test(matched) ? "pascal" : "camel";
}

/**
 * Does this match sit inside an identifier, domain, path or key rather than in
 * running text? Only the immediate neighbours are consulted — that is exactly
 * the signal that distinguishes `oldbrand.ai` from `...from oldbrand. If you`.
 */
export function isTechnical(text, start, end) {
  const prev = start > 0 ? text[start - 1] : "";
  const beforePrev = start > 1 ? text[start - 2] : "";
  const rest = text.slice(end);
  const next = rest.charAt(0);

  // Glued to a name, path segment, e-mail local part or identifier fragment.
  if (prev && /[A-Za-z0-9_$@/\\-]/.test(prev)) return true;
  // A dot only glues when it follows a name (`app.oldbrand`), not a sentence end.
  if (prev === "." && /[A-Za-z0-9]/.test(beforePrev)) return true;
  if (prev === ":" && beforePrev !== "") return true;

  if (next && /[A-Za-z0-9_$-]/.test(next)) return true;
  if (next === "/" || next === "@" || next === "\\") return true;
  // `.ai`, `.com.au` — but not the full stop that ends a sentence.
  if (next === "." && /^\.[A-Za-z0-9]/.test(rest)) return true;
  // `oldbrand:boot-reloaded` — a namespaced storage key.
  if (next === ":" && /^:[A-Za-z0-9_/\\-]/.test(rest)) return true;
  // Split word-mark: `oldbrand<span className="accent">.ai</span>` is a domain.
  if (next === "<" && /^<[^<>]{0,240}>\s*\.[A-Za-z]{2,}/.test(rest)) return true;

  return false;
}

/** Ambiguous shapes resolve differently in code than they do in prose. */
export function resolveForm(form, technical) {
  if (form === "ambiguousLower") return technical ? "slug" : "display";
  if (form === "ambiguousTitle") return technical ? "pascal" : "display";
  if (form === "ambiguousUpper") return technical ? "upper" : "displayUpper";
  return form;
}

/**
 * Guard against matching the middle of an unrelated word. `_`, `-` and `.` are
 * legitimate neighbours (they build identifiers), and a case change is a real
 * word boundary (`appOldbrand` → `app` + `Oldbrand`), but plain letters are not.
 */
function onWordBoundary(text, start, end, matched) {
  const prev = start > 0 ? text[start - 1] : "";
  const next = end < text.length ? text[end] : "";
  const leadingOk = !prev || !/[A-Za-z0-9]/.test(prev) || /[A-Z]/.test(matched.charAt(0));
  const trailingOk = !next || !/[a-z0-9]/.test(next);
  return leadingOk && trailingOk;
}

/** Replace whole domains so the TLD can change too (`oldbrand.ai` → `x.com.au`). */
export function rewriteDomains(text, source, toDomain) {
  const alt = source.patterns.map(escapeRegExp).join("|");
  const re = new RegExp(`((?:[A-Za-z0-9-]+\\.)*)(?:${alt})(?:\\.[A-Za-z]{2,24}){1,2}`, "gi");
  let count = 0;
  const out = text.replace(re, (match, subdomain, offset) => {
    const prev = offset > 0 ? text[offset - 1] : "";
    if (prev && /[A-Za-z0-9]/.test(prev)) return match;
    count += 1;
    return `${subdomain}${toDomain}`;
  });
  return { text: out, count };
}

/** Apply literal, highest-precedence string swaps from the config. */
export function rewriteOverrides(text, overrides) {
  let out = text;
  let count = 0;
  const keys = Object.keys(overrides).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (!key) continue;
    const re = new RegExp(escapeRegExp(key), "g");
    out = out.replace(re, () => {
      count += 1;
      return overrides[key];
    });
  }
  return { text: out, count };
}

/**
 * Swap every spelling of `source` for the matching spelling of `target`.
 * `slugOnly` forces identifier output — used for files such as package.json
 * where a display name with spaces would be invalid.
 */
export function rewriteBrand(text, source, target, { slugOnly = false } = {}) {
  const alt = source.patterns.map(escapeRegExp).join("|");
  const re = new RegExp(`(?:${alt})`, "gi");
  const parts = [];
  let cursor = 0;
  let count = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    const matched = match[0];
    const start = match.index;
    const end = start + matched.length;
    if (!onWordBoundary(text, start, end, matched)) {
      re.lastIndex = start + 1;
      continue;
    }
    const form = resolveForm(detectForm(matched), slugOnly || isTechnical(text, start, end));
    parts.push(text.slice(cursor, start), render(form, target));
    cursor = end;
    count += 1;
  }

  if (!count) return { text, count };
  parts.push(text.slice(cursor));
  return { text: parts.join(""), count };
}

/** Run every pass over one file's contents, in precedence order. */
export function rewriteContents(text, plan, { slugOnly = false } = {}) {
  let out = text;
  let count = 0;

  const overrides = rewriteOverrides(out, plan.overrides ?? {});
  out = overrides.text;
  count += overrides.count;

  if (plan.toDomain) {
    const domains = rewriteDomains(out, plan.source, plan.toDomain);
    out = domains.text;
    count += domains.count;
  }

  const brand = rewriteBrand(out, plan.source, plan.target, { slugOnly });
  out = brand.text;
  count += brand.count;

  return { text: out, count, changed: out !== text };
}

/** Rename a file or directory basename, always in identifier form. */
export function rewriteBasename(name, plan) {
  const { text } = rewriteBrand(name, plan.source, plan.target, { slugOnly: true });
  return text;
}

/**
 * Count surviving mentions of `source` in `text`, using the same word-boundary
 * rules as the rewriter. Drives the post-run check that the old brand is really
 * gone — the guarantee that matters when the repo is handed to someone else.
 */
export function countBrand(text, source) {
  const alt = source.patterns.map(escapeRegExp).join("|");
  const re = new RegExp(`(?:${alt})`, "gi");
  let count = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (onWordBoundary(text, match.index, match.index + match[0].length, match[0])) count += 1;
    else re.lastIndex = match.index + 1;
  }
  return count;
}
