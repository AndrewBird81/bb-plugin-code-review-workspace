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
export function classifyFile(path: string): FileClass {
  const p = path.toLowerCase();
  const name = base(p);

  const is = (category: FileCategory, skippable: boolean): FileClass => ({
    category,
    skippable,
    label: category,
  });

  if (LOCKFILES.has(name)) return is("lockfile", true);

  if (
    /(^|\/)__tests__\//.test(p) ||
    /(^|\/)__snapshots__\//.test(p) ||
    /(^|\/)(tests|spec)\//.test(p) ||
    /(^|\/)src\/test\//.test(p) ||
    /\.(test|spec)\.[a-z0-9]+$/.test(name) ||
    /_test\.(go|py)$/.test(name) ||
    /^test_.+\.py$/.test(name) ||
    name.endsWith(".snap")
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
