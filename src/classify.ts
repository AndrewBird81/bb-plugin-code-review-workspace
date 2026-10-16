// Deterministic, LLM-free classification of a changed file by its path, so the
// sidebar can tag files that are low-value to review (generated output,
// lockfiles) and let the reviewer skip them. Tests get a tag but stay in review. Kept pure and shared between the
// sidebar and the per-file diff badge.
import { compileGlob, globMatches, type Glob } from "./glob";

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
  // Vendored dependencies, and code protoc or build_runner writes, even their tests.
  if (/(^|\/)(vendor|third_party|pods)\//.test(p) || /(\.pb\.go|_pb2\.py|_pb2_grpc\.py|\.g\.dart|\.freezed\.dart)$/.test(name)) return is("generated", true);

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

/** A .gitattributes pattern, by gitignore's rules: without a slash it matches a name at any depth. */
function attributePattern(pattern: string): Glob | null {
  return compileGlob(pattern.includes("/") ? pattern.replace(/^\//, "") : `**/${pattern}`);
}

// The file comes from the PR and every rule is tried on every path, so the rules' length is capped.
const MAX_ATTRIBUTE_PATTERNS_LENGTH = 1000;

/**
 * The paths a repo's root .gitattributes marks linguist-generated or linguist-vendored, as GitHub
 * folds them. The last line matching a path sets each attribute, and a directory-only pattern
 * ("build/") matches no file, as in git.
 */
export function declaredGenerated(gitattributes: string, paths: string[]): string[] {
  let budget = MAX_ATTRIBUTE_PATTERNS_LENGTH;
  const rules = gitattributes.split(/\r?\n/).flatMap((line) => {
    const [pattern, ...attributes] = line.trim().split(/\s+/);
    if (!pattern || pattern.startsWith("#") || pattern.startsWith("[attr]") || pattern.endsWith("/")) return [];
    const set = new Map<string, boolean>();
    for (const attribute of attributes) {
      const [, unset, name, value] = attribute.match(/^([-!]?)(linguist-(?:generated|vendored))(?:=(.*))?$/) ?? [];
      if (name) set.set(name, !unset && value !== "false");
    }
    const match = set.size && (budget -= pattern.length) >= 0 ? attributePattern(pattern) : null;
    return match ? [{ match, set }] : [];
  });
  return paths.filter((path) => {
    const state = new Map<string, boolean>();
    for (const rule of rules) if (globMatches(rule.match, path)) for (const [name, on] of rule.set) state.set(name, on);
    return state.get("linguist-generated") === true || state.get("linguist-vendored") === true;
  });
}
