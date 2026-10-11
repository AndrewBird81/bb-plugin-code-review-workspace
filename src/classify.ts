// Deterministic, LLM-free classification of a changed file by its path, so the
// sidebar can tag files that are low-value to review (generated output,
// lockfiles) and let the reviewer skip them. Tests get a tag but stay in review. Kept pure and shared between the
// sidebar and the per-file diff badge.

export type FileCategory = "test" | "generated" | "lockfile" | "docs" | "config" | "code";

export interface FileClass {
  category: FileCategory;
  /** True for categories a reviewer can usually skip or skim. */
  skippable: boolean;
  /** Short human tag, e.g. "test" / "lockfile". */
  label: string;
}

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json",
  "cargo.lock",
  "poetry.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "bun.lock",
  "bun.lockb",
  "uv.lock",
  "pipfile.lock",
  "flake.lock",
  "package.resolved",
]);

function base(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

// Order matters: the first matching rule wins. Tests and lockfiles are checked
// before the generic "generated" / "code" fallbacks so a `dist/foo.test.js`
// still reads as a test, and a lockfile is never mistaken for config.
/** `declared`: the repo's .gitattributes marks the file generated or vendored. */
export function classifyFile(path: string, declared = false): FileClass {
  const p = path.toLowerCase();
  const name = base(p);

  const is = (category: FileCategory, skippable: boolean): FileClass => ({
    category,
    skippable,
    label: category,
  });

  if (LOCKFILES.has(name)) return is("lockfile", true);
  if (declared) return is("generated", true);

  // Test snapshots are written by the test runner, not by hand.
  if (/(^|\/)__snapshots__\//.test(p) || name.endsWith(".snap")) return is("generated", true);

  if (
    /(^|\/)__tests__\//.test(p) ||
    /(^|\/)(tests|spec)\//.test(p) ||
    /(^|\/)src\/test\//.test(p) ||
    /\.(test|spec)\.[a-z0-9]+$/.test(name) ||
    /_test\.(go|py)$/.test(name) ||
    /^test_.+\.py$/.test(name)
  ) {
    return is("test", false);
  }

  if (
    /(^|\/)(dist|build|out|coverage)\//.test(p) ||
    /\.min\.[a-z0-9]+$/.test(name) ||
    /\.generated\.[a-z0-9]+$/.test(name) ||
    (name.endsWith(".d.ts") && /(^|\/)generated\//.test(p))
  ) {
    return is("generated", true);
  }

  if (name.endsWith(".md") || name.endsWith(".mdx") || /(^|\/)docs?\//.test(p)) {
    return is("docs", false);
  }

  if (
    name.startsWith(".") ||
    name.endsWith(".json") ||
    name.endsWith(".yml") ||
    name.endsWith(".yaml") ||
    name.endsWith(".toml") ||
    name.endsWith(".ini") ||
    name.endsWith(".env")
  ) {
    return is("config", false);
  }

  return is("code", false);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A .gitattributes pattern, by gitignore's rules: without a slash it matches a name at any depth. */
function attributePattern(pattern: string): RegExp {
  const anchored = pattern.includes("/");
  const glob = pattern.replace(/^\//, "");
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" is any number of directories, even none; a trailing "**" is everything inside.
      if (glob[i + 2] === "/") { source += "(?:.*/)?"; i += 2; } else { source += ".*"; i++; }
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else if (c === "[" && glob.indexOf("]", i + 2) > 0) {
      const end = glob.indexOf("]", i + 2);
      source += `[${glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      i = end;
    } else if (c === "\\" && i + 1 < glob.length) source += escapeRegExp(glob[++i]);
    else source += escapeRegExp(c);
  }
  return new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`);
}

/**
 * The paths a repo's root .gitattributes marks linguist-generated or linguist-vendored, as GitHub
 * folds them. The last line matching a path sets each attribute, and a directory-only pattern
 * ("build/") matches no file, as in git.
 */
export function declaredGenerated(gitattributes: string, paths: string[]): string[] {
  const rules = gitattributes.split(/\r?\n/).flatMap((line) => {
    const [pattern, ...attributes] = line.trim().split(/\s+/);
    if (!pattern || pattern.startsWith("#") || pattern.startsWith("[attr]") || pattern.endsWith("/")) return [];
    const set = new Map<string, boolean>();
    for (const attribute of attributes) {
      const [, unset, name, value] = attribute.match(/^([-!]?)(linguist-(?:generated|vendored))(?:=(.*))?$/) ?? [];
      if (name) set.set(name, !unset && value !== "false");
    }
    return set.size ? [{ match: attributePattern(pattern), set }] : [];
  });
  return paths.filter((path) => {
    const state = new Map<string, boolean>();
    for (const rule of rules) if (rule.match.test(path)) for (const [name, on] of rule.set) state.set(name, on);
    return state.get("linguist-generated") === true || state.get("linguist-vendored") === true;
  });
}
