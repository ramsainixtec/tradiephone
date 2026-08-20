/**
 * Argument parsing.
 *
 * The command is meant to read like a sentence:
 *
 *     npx white-label from: oldbrand to: bright plumbing
 *
 * so a value runs from its key up to the next recognised key. `--from=x` and
 * `--from x` work too, for anyone who prefers conventional flags.
 */

const KEYS = new Set(["from", "to", "display", "slug", "domain", "root"]);

const FLAG_ALIASES = new Map([
  ["dry", "dry-run"],
  ["n", "dry-run"],
  ["h", "help"],
  ["f", "allow-dirty"],
  ["force", "allow-dirty"],
]);

const KNOWN_FLAGS = new Set([
  "dry-run",
  "allow-dirty",
  "no-locks",
  "no-rename",
  "no-config",
  "quiet",
  "yes",
  "help",
  "version",
]);

const normaliseKey = (value) => value.toLowerCase().replace(/^-+/, "");

export function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  const rest = [];
  const unknown = [];
  let current = null;

  const append = (key, token) => {
    values[key] = values[key] ? `${values[key]} ${token}` : token;
  };

  for (const token of argv) {
    if (token === "--") {
      current = null;
      continue;
    }

    if (token.startsWith("--") || (token.startsWith("-") && token.length === 2 && !/^-\d/.test(token))) {
      const body = token.replace(/^-+/, "");
      const eq = body.indexOf("=");
      const rawKey = eq === -1 ? body : body.slice(0, eq);
      const key = normaliseKey(rawKey);

      if (KEYS.has(key)) {
        current = key;
        if (eq !== -1) append(key, body.slice(eq + 1));
        continue;
      }

      const flag = FLAG_ALIASES.get(key) ?? key;
      if (KNOWN_FLAGS.has(flag)) flags.add(flag);
      else unknown.push(token);
      current = null;
      continue;
    }

    // `from:` / `from:oldbrand` / `to:` — the sentence-style form.
    const inline = /^([A-Za-z][A-Za-z-]*):(.*)$/.exec(token);
    if (inline && KEYS.has(inline[1].toLowerCase())) {
      current = inline[1].toLowerCase();
      if (inline[2]) append(current, inline[2]);
      continue;
    }

    if (current) append(current, token);
    else rest.push(token);
  }

  for (const key of Object.keys(values)) values[key] = values[key].trim();

  return { values, flags, rest, unknown };
}

export { KEYS, KNOWN_FLAGS };
