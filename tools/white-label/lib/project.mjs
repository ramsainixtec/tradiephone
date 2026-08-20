/**
 * Project discovery: where the repo root is, which files are in scope, and how
 * the current brand is remembered between runs.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const CONFIG_FILE = "white-label.config.json";

/**
 * Directories that never contain source worth rebranding (or must not be
 * touched). Everything else is fair game — including dotfiles such as
 * `.gitignore` and tool config such as `.claude/`, because a repo handed to
 * another business must not carry the previous brand anywhere.
 *
 * `tools/white-label` is excluded so the tool cannot rewrite its own fixtures
 * mid-run; it deliberately contains no real brand of its own.
 */
export const DEFAULT_SKIP_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "dist-ssr",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".cache",
  ".vite",
  ".idea",
  "tools/white-label",
];

/**
 * The post-run sweep looks almost everywhere, including build output and the
 * directories skipped above, so anything left carrying the old brand is
 * reported rather than silently shipped.
 */
export const VERIFY_SKIP_DIRS = [".git", "node_modules", "tools/white-label"];

/** Individual files excluded from the sweep. */
export const DEFAULT_SKIP_FILES = [CONFIG_FILE, ".DS_Store"];

/**
 * Files where the brand is only ever an identifier. package.json's `name` field
 * would become invalid if a display name with spaces were written into it.
 */
export const DEFAULT_SLUG_ONLY_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  ".npmrc",
];

export const LOCK_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".tif", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".mp4", ".mov", ".avi", ".webm",
  ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".node", ".wasm", ".bin", ".class", ".jar",
  ".pyc", ".db", ".sqlite", ".sqlite3", ".lockb",
]);

const MAX_FILE_BYTES = 12 * 1024 * 1024;

/** Walk up from `start` until a package.json or .git marks the project root. */
export function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${error.message}`);
  }
}

export function saveConfig(root, config) {
  const file = path.join(root, CONFIG_FILE);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return file;
}

/** Uncommitted changes, so a sweep can be undone with `git restore .`. */
export function gitStatus(root) {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { isRepo: true, dirty: out.trim().length > 0 };
  } catch {
    return { isRepo: false, dirty: false };
  }
}

const toPosix = (value) => value.split(path.sep).join("/");

function isSkippedDir(relative, name, skipDirs) {
  return skipDirs.some((entry) => entry === name || entry === relative || relative.startsWith(`${entry}/`));
}

/** Text-file heuristic: a NUL byte in the first block means binary. */
function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i += 1) if (buffer[i] === 0) return true;
  return false;
}

/**
 * Every file eligible for rewriting, as repo-relative POSIX paths.
 * `skipped` collects what was passed over and why, so the report can say so.
 */
export function collectFiles(root, options = {}) {
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const skipFiles = new Set(options.skipFiles ?? DEFAULT_SKIP_FILES);
  const includeLocks = options.includeLocks !== false;
  const files = [];
  const skipped = { binary: [], oversized: [], locks: [] };

  const walk = (absolute, relative) => {
    let entries;
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbsolute = path.join(absolute, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isSkippedDir(childRelative, entry.name, skipDirs)) continue;
        walk(childAbsolute, childRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (skipFiles.has(entry.name) || skipFiles.has(childRelative)) continue;
      if (LOCK_FILES.has(entry.name) && !includeLocks) {
        skipped.locks.push(childRelative);
        continue;
      }
      if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        skipped.binary.push(childRelative);
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(childAbsolute);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped.oversized.push(childRelative);
        continue;
      }
      files.push(childRelative);
    }
  };

  walk(root, "");
  return { files, skipped };
}

/** Read a file as UTF-8, or null when it turns out to be binary. */
export function readTextFile(root, relative) {
  const buffer = fs.readFileSync(path.join(root, relative));
  if (looksBinary(buffer)) return null;
  return buffer.toString("utf8");
}

export function writeTextFile(root, relative, contents) {
  fs.writeFileSync(path.join(root, relative), contents, "utf8");
}

export function isSlugOnly(relative, patterns) {
  const name = relative.split("/").pop() ?? relative;
  if (name.startsWith(".env")) return true;
  return patterns.some((entry) => entry === name || entry === relative);
}

/**
 * Directories and files whose own name carries the brand, deepest first so a
 * child is renamed before its parent directory moves out from under it.
 */
export function collectPaths(root, options = {}) {
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const found = [];

  const walk = (absolute, relative, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && isSkippedDir(childRelative, entry.name, skipDirs)) continue;
      found.push({ relative: childRelative, name: entry.name, depth, isDir: entry.isDirectory() });
      if (entry.isDirectory()) walk(path.join(absolute, entry.name), childRelative, depth + 1);
    }
  };

  walk(root, "", 0);
  return found.sort((a, b) => b.depth - a.depth);
}

export { toPosix };
