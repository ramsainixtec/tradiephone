/**
 * Brand naming.
 *
 * A product label is written a dozen different ways across a codebase: as a
 * domain (`oldbrand.ai`), an npm package (`oldbrand-server`), a storage key
 * (`oldbrand_token`), a React identifier (`OldbrandLogo`) and as prose the user
 * actually reads ("Welcome to Oldbrand"). This module turns one free-form label
 * into every one of those spellings, so the rewriter can both *find* the old
 * brand in any shape and *write* the new one back in the same shape.
 */

/** Split a label into words, honouring camelCase / PascalCase boundaries. */
export function splitWords(label) {
  return String(label)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

const cap = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** Case-insensitive dedupe, longest first so the matcher prefers whole spellings. */
function candidates(list) {
  const seen = new Map();
  for (const value of list) {
    if (!value) continue;
    const key = value.toLowerCase();
    if (!seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()].sort((a, b) => b.length - a.length);
}

/**
 * Expand `label` into its casing variants.
 *
 * `overrides.display` pins the human-readable name (defaults to Title Case when
 * the label was typed all-lowercase, otherwise the label as typed), and
 * `overrides.slug` pins the identifier form used for domains, package names and
 * storage keys (defaults to the words squashed together in lowercase).
 */
export function analyze(label, overrides = {}) {
  const raw = String(label ?? "").trim().replace(/\s+/g, " ");
  const words = splitWords(raw).map((word) => word.toLowerCase());
  if (!words.length) throw new Error(`Brand label "${label}" has no letters or digits in it.`);

  const compact = words.join("");
  const pascal = words.map(cap).join("");
  const spaced = words.map(cap).join(" ");
  const display = overrides.display?.trim() || (raw === raw.toLowerCase() ? spaced : raw);
  const slug = overrides.slug?.trim().toLowerCase() || compact;

  return {
    raw,
    words,
    display,
    displayUpper: display.toUpperCase(),
    slug,
    compact,
    pascal,
    camel: pascal.charAt(0).toLowerCase() + pascal.slice(1),
    kebab: words.join("-"),
    snake: words.join("_"),
    constant: words.join("_").toUpperCase(),
    upper: compact.toUpperCase(),
    spaced,
    /** Every spelling this brand may already appear as, longest first. */
    patterns: candidates([raw, display, spaced, compact, pascal, words.join("-"), words.join("_")]),
  };
}

/** Render `brand` in the casing named by `form`. */
export function render(form, brand) {
  switch (form) {
    case "display": return brand.display;
    case "displayUpper": return brand.displayUpper;
    case "slug": return brand.slug;
    case "kebab": return brand.kebab;
    case "kebabUpper": return brand.kebab.toUpperCase();
    case "snake": return brand.snake;
    case "constant": return brand.constant;
    case "pascal": return brand.pascal;
    case "camel": return brand.camel;
    case "upper": return brand.upper;
    default: return brand.display;
  }
}

/**
 * A slug has to survive as an npm package name, a DNS label and a storage key.
 * Returns a list of human-readable problems (empty when the slug is fine).
 */
export function slugWarnings(slug) {
  const problems = [];
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
    problems.push(`slug "${slug}" is not a valid npm package name — pass slug: <value> to override it`);
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    problems.push(`slug "${slug}" is not a valid DNS label — domains built from it may be invalid`);
  }
  return problems;
}
