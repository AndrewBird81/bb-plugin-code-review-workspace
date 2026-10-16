// What a lockfile's diff adds and removes: how many packages, and the hosts an added one downloads from that its
// registry isn't. Read from the diff's lines alone, so it's the same in the panel and for the agents.
import { patchRows } from "../src/patch";

export interface LockfileDigest {
  /** Packages only the added lines name, and only the removed ones: a version bump counts in neither. */
  added: number;
  removed: number;
  /** Hosts an added entry downloads from that aren't a known registry, or already in the lockfile's removed or unchanged lines. */
  hosts: string[];
}

/** Public registries, which never need a word. */
const REGISTRIES = new Set(["registry.npmjs.org", "registry.yarnpkg.com", "registry.npmmirror.com"]);

type Format = { name: (code: string) => string | null; url?: (code: string) => string | null };
const first = (pattern: RegExp) => (code: string) => code.match(pattern)?.[1] ?? null;
// "@scope/name@^1.0.0" or "name@npm:1.0.0": the name before its version.
const nameOf = (spec: string) => spec.replace(/^["']|["']$/g, "").match(/^(@?[^@]+)@/)?.[1] ?? null;
const FORMATS: Record<string, Format> = {
  npm: { name: first(/^\s*"((?:[^"]*\/)?node_modules\/(?:@[^/"]+\/)?[^/"]+)"\s*:\s*\{/), url: first(/^\s*"resolved"\s*:\s*"([^"]+)"/) },
  yarn: {
    name: (code) => /^[^\s#].*:\s*$/.test(code) && !code.startsWith("__metadata") ? nameOf(code.split(",")[0].trim().replace(/:$/, "")) : null,
    url: first(/^\s+resolved\s+"?([^"\s]+)"?/),
  },
  // "  /name@1.0.0:", "  name@1.0.0:", or "  /name/1.0.0:", under packages (and snapshots).
  pnpm: {
    name: (code) => { const key = code.match(/^ {2}['"]?([^\s'"]+?)['"]?:\s*$/)?.[1]; return key ? nameOf(key.replace(/^\//, "")) ?? key.match(/^\/((?:@[^/]+\/)?[^/]+)\/[^/]+$/)?.[1] ?? null : null; },
    url: first(/\btarball:\s*['"]?([^'",}\s]+)/),
  },
  names: { name: first(/^name = "([^"]+)"/) },
  go: { name: first(/^(\S+) v\S+(?:\/go\.mod)? h1:/) },
};
const FORMAT_OF: Record<string, keyof typeof FORMATS> = {
  "package-lock.json": "npm", "npm-shrinkwrap.json": "npm", "yarn.lock": "yarn", "pnpm-lock.yaml": "pnpm",
  "cargo.lock": "names", "poetry.lock": "names", "go.sum": "go",
};

const hostOf = (url: string) => url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:?#]+)/i)?.[1]?.toLowerCase() ?? null;

/** A lockfile's digest, or null for another file, or a lockfile whose diff adds and removes no package and no host. */
export function lockfileDigest(path: string, diff: string): LockfileDigest | null {
  const format = FORMATS[FORMAT_OF[(path.split("/").pop() ?? "").toLowerCase()]];
  if (!format) return null;
  const added = new Set<string>(), removed = new Set<string>(), base = new Set<string>(), hosts = new Set<string>();
  for (const row of patchRows(diff)) {
    if (row.kind !== "+" && row.kind !== "-" && row.kind !== " ") continue;
    const code = row.text.slice(1);
    const name = format.name(code);
    if (name && row.kind !== " ") (row.kind === "+" ? added : removed).add(name);
    const url = format.url?.(code);
    const host = url && hostOf(url);
    if (host) (row.kind === "+" ? hosts : base).add(host);
  }
  const digest = {
    added: [...added].filter((name) => !removed.has(name)).length,
    removed: [...removed].filter((name) => !added.has(name)).length,
    hosts: [...hosts].filter((host) => !REGISTRIES.has(host) && !base.has(host)),
  };
  return digest.added || digest.removed || digest.hosts.length ? digest : null;
}

/** "+3 −1 packages", or null when it adds and removes none. */
export function packagesChange({ added, removed }: LockfileDigest): string | null {
  return added || removed ? `+${added} −${removed} package${added + removed === 1 ? "" : "s"}` : null;
}

/** For the agents: "+3 −1 packages, downloads from evil.example.com". */
export function digestText(digest: LockfileDigest): string {
  return [packagesChange(digest), digest.hosts.length ? `downloads from ${digest.hosts.join(", ")}` : null].filter(Boolean).join(", ");
}
