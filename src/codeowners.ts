// Who owns each changed file, by the repo's CODEOWNERS (a PR's base branch, a local review's new side), matched as GitHub does.
import type { ReviewMeta } from "./store";
import { ghErrorMessage, type runGh, type runGit } from "./gh";
import { gitFile, localRevs, workingTreeFile, type Read } from "./file-contents";
import { globMatches, type Glob } from "./glob";

/** Where GitHub looks for CODEOWNERS, in order; the first one found is the one used. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

export interface OwnerRule { pattern: Glob[]; owners: string[] }
export interface FileOwners { file: string; owners: string[]; mine: boolean }

/**
 * A CODEOWNERS pattern as globs over repo-relative paths, one of which a path matches: gitignore's rules as GitHub
 * documents them. A leading or inner "/" anchors it at the root; a trailing "/" matches what's under a directory;
 * otherwise it matches a file, or a directory and what's under it, at any depth. "docs/*" matches only docs' own files.
 * Null for what GitHub doesn't support: "!" and "[ ]". Globs, as src/glob.ts matches them, can't backtrack: the
 * regular expression this was stalled the server for minutes on a rule of many stars and a long name.
 */
export function ownerPattern(pattern: string): Glob[] | null {
  if (!pattern || pattern.startsWith("!") || /[[\]]/.test(pattern)) return null;
  const directory = pattern.endsWith("/");
  const trimmed = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const anchored = pattern.startsWith("/") || trimmed.includes("/");
  const segments = trimmed.split("/");
  const literal = (char: string): Glob[number] => ({ kind: "char", test: (c) => c === char });
  // Unanchored, any number of directories first.
  const glob: Glob = anchored ? [] : [{ kind: "dirs" }];
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      // Any number of directories: leading, inner, or (last) everything below.
      glob.push({ kind: last ? "globstar" : "dirs" });
      return;
    }
    for (let i = 0; i < segment.length; i++) {
      glob.push(segment[i] === "*" ? { kind: "star" } : segment[i] === "?" ? { kind: "char", test: (c) => c !== "/" } : literal(segment[i]));
    }
    if (!last) glob.push(literal("/"));
  });
  const below: Glob = [...glob, literal("/"), { kind: "globstar" }];
  if (directory) return [below];
  return segments.at(-1) === "*" || segments.at(-1) === "**" ? [glob] : [glob, below];
}

/** The rules of a CODEOWNERS file, in order. Comments, blank lines, and patterns GitHub skips are left out. */
export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Whitespace separates the pattern from its owners, unless escaped; "\#" is a literal #.
    const tokens = line.match(/(?:\\.|[^\s\\])+/g) ?? [];
    const [first, ...rest] = tokens;
    if (!first) continue;
    const owners: string[] = [];
    for (const token of rest) {
      if (token.startsWith("#")) break;
      owners.push(token);
    }
    const pattern = ownerPattern(first.replace(/\\(.)/g, "$1"));
    if (pattern) rules.push({ pattern, owners });
  }
  return rules;
}

/** A file's owners: the last rule that matches wins, and one without owners leaves the file unowned. */
export function ownersOf(rules: readonly OwnerRule[], path: string): string[] {
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i].pattern.some((glob) => globMatches(glob, path))) return rules[i].owners;
  return [];
}

/** Whether you own a file: as @login, or through a team you're on ("org/slug", lowercase, as the viewer reads them). */
export function ownedBy(owners: readonly string[], login: string | null, teams: ReadonlySet<string>): boolean {
  const me = login ? `@${login.toLowerCase()}` : null;
  return owners.some((owner) => {
    const name = owner.toLowerCase();
    return name === me || (name.startsWith("@") && name.includes("/") && teams.has(name.slice(1)));
  });
}

// GitHub takes a PR's code owners from its base branch, so the PR's author can't choose them; null when that branch is gone.
const QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){baseRef{target{...on Commit{
  ${CODEOWNERS_PATHS.map((path, index) => `${"abc"[index]}:file(path:${JSON.stringify(path)}){object{...on Blob{text}}}`).join(" ")}}}}}}}`;

/** A PR's reads are kept per head, as the base branch's tip isn't known without one: the text, or "" without one. */
const cache = new Map<string, string>();
const CACHE_SIZE = 64;

/**
 * The repo's CODEOWNERS: "" when it has none. A PR reads it at its base branch's tip, all three places in one
 * GraphQL call; a local review at the diff's new side.
 */
export async function readCodeowners(gh: { runGh: typeof runGh; runGit: typeof runGit }, review: ReviewMeta): Promise<Read> {
  if (review.kind === "pr") {
    if (!review.repo || !review.number || !review.headSha) return { text: "" };
    const key = `${review.repo}#${review.number}@${review.headSha}`;
    const cached = cache.get(key);
    if (cached !== undefined) return { text: cached };
    const [owner, name] = review.repo.split("/");
    const out = await gh.runGh(["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, "-F", `number=${review.number}`]);
    type File = { object?: { text?: string } | null } | null;
    let body: { data?: { repository?: { pullRequest?: { baseRef?: { target?: Record<string, File> | null } | null } | null } | null }; errors?: { type?: string }[] } | undefined;
    try { body = JSON.parse(out.stdout); } catch { body = undefined; }
    const pr = body?.data?.repository?.pullRequest;
    // Each place without CODEOWNERS is a NOT_FOUND error beside the data, and gh fails.
    if (!pr || body?.errors?.some((error) => error.type !== "NOT_FOUND")) return { error: `Couldn’t read CODEOWNERS: ${ghErrorMessage(out)}` };
    const base = pr.baseRef?.target;
    const text = [base?.a, base?.b, base?.c].find((file) => typeof file?.object?.text === "string")?.object?.text ?? "";
    cache.set(key, text);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    return { text };
  }
  if (!review.cwd || !review.gitRef) return { text: "" };
  const revs = await localRevs(gh.runGit, review);
  if ("error" in revs) return revs;
  for (const path of CODEOWNERS_PATHS) {
    const read = revs.to === null ? await workingTreeFile(review.cwd, path) : await gitFile(gh.runGit, review.cwd, revs.to, path);
    if ("text" in read) return read;
  }
  return { text: "" };
}

/** Each changed file with owners, and whether you or a team you're on is one of them. */
export async function codeOwners(
  gh: { runGh: typeof runGh; runGit: typeof runGit },
  review: ReviewMeta,
  paths: readonly string[],
  viewer: () => Promise<{ login: string | null; teams: ReadonlySet<string> }>,
): Promise<FileOwners[]> {
  const read = await readCodeowners(gh, review);
  if ("error" in read) throw new Error(read.error);
  const rules = parseCodeowners(read.text);
  const owned = paths.map((file) => ({ file, owners: ownersOf(rules, file) })).filter((entry) => entry.owners.length);
  if (!owned.length) return [];
  const { login, teams } = await viewer();
  return owned.map((entry) => ({ ...entry, mine: ownedBy(entry.owners, login, teams) }));
}

/** read_pr_context's line on what the reviewer owns, or null without CODEOWNERS owners. */
export function describeOwnership(files: readonly FileOwners[]): string | null {
  if (!files.length) return null;
  const mine = files.filter((entry) => entry.mine).map((entry) => entry.file);
  if (!mine.length) return `CODEOWNERS: the reviewer owns none of the changed files, directly or through a team.`;
  const listed = mine.slice(0, 50).join(", ");
  return `CODEOWNERS: the reviewer owns ${mine.length} of the changed files, directly or through a team: ${listed}${mine.length > 50 ? ", …" : ""}. Look hardest at those.`;
}
