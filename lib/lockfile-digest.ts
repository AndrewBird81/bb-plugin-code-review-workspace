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

type Format = {
  name?: (code: string) => string | null;
  /** The URL a line's entry downloads from; without it, every URL on the line. */
  url?: (code: string) => string | null;
  /** Only a "url" inside these objects downloads: composer.lock's other URLs are homepages, support and funding. */
  urlIn?: string[];
  /** Public registries, which never need a word: a host, or a host and path a URL is at or under. */
  registries: string[];
};
const first = (pattern: RegExp) => (code: string) => code.match(pattern)?.[1] ?? null;
// "@scope/name@^1.0.0" or "name@npm:1.0.0": the name before its version.
const nameOf = (spec: string) => spec.replace(/^["']|["']$/g, "").match(/^(@?[^@]+)@/)?.[1] ?? null;
const NPM = ["registry.npmjs.org", "registry.yarnpkg.com", "registry.npmmirror.com"];
const PYPI = ["pypi.org", "files.pythonhosted.org"];
const tomlName = first(/^name = "([^"]+)"/);
const FORMATS: Record<string, Format> = {
  npm: { name: first(/^\s*"((?:[^"]*\/)?node_modules\/(?:@[^/"]+\/)?[^/"]+)"\s*:\s*\{/), url: first(/^\s*"resolved"\s*:\s*"([^"]+)"/), registries: NPM },
  yarn: {
    name: (code) => /^[^\s#].*:\s*$/.test(code) && !code.startsWith("__metadata") ? nameOf(code.split(",")[0].trim().replace(/:$/, "")) : null,
    url: first(/^\s+resolved\s+"?([^"\s]+)"?/),
    registries: NPM,
  },
  // "  /name@1.0.0:", "  name@1.0.0:", or "  /name/1.0.0:", under packages (and snapshots).
  pnpm: {
    name: (code) => { const key = code.match(/^ {2}['"]?([^\s'"]+?)['"]?:\s*$/)?.[1]; return key ? nameOf(key.replace(/^\//, "")) ?? key.match(/^\/((?:@[^/]+\/)?[^/]+)\/[^/]+$/)?.[1] ?? null : null; },
    url: first(/\btarball:\s*['"]?([^'",}\s]+)/),
    registries: NPM,
  },
  cargo: { name: tomlName, registries: ["index.crates.io", "static.crates.io", "github.com/rust-lang/crates.io-index"] },
  poetry: { name: tomlName, registries: PYPI },
  go: { name: first(/^(\S+) v\S+(?:\/go\.mod)? h1:/), registries: [] },
  // api.github.com's zipballs take any repository, so github.com's clones of one need no word either.
  composer: { urlIn: ["source", "dist"], registries: ["repo.packagist.org", "packagist.org", "api.github.com", "codeload.github.com", "github.com"] },
  gem: { registries: ["rubygems.org"] },
  python: { registries: PYPI },
  bun: { registries: ["registry.npmjs.org"] },
  // Most Swift packages are pinned at their GitHub repository, so a new one there needs no word, as in composer.
  swift: { registries: ["github.com"] },
  other: { registries: [] },
};
const FORMAT_OF: Record<string, keyof typeof FORMATS> = {
  "package-lock.json": "npm", "npm-shrinkwrap.json": "npm", "yarn.lock": "yarn", "pnpm-lock.yaml": "pnpm",
  "cargo.lock": "cargo", "poetry.lock": "poetry", "go.sum": "go", "composer.lock": "composer", "gemfile.lock": "gem",
  "uv.lock": "python", "pipfile.lock": "python", "bun.lock": "bun", "flake.lock": "other", "package.resolved": "swift",
};

/** A URL's host and path, lowercase: "scheme://[user@]host[:port]/path", or git's "user@host:path". */
function placeOf(url: string): { host: string; path: string } | null {
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:?#]+)(?::\d*)?([^?#]*)/i) ?? url.match(/^[\w.-]+@([a-z0-9.-]+):(?!\/\/)([^?#]*)/i);
  return m ? { host: m[1].toLowerCase(), path: m[2].replace(/^\/*/, "/").toLowerCase() } : null;
}

// Every URL on a line, and git's scp-style "git@host:owner/repo", which isn't one; JSON may write / as \/. A scheme
// starts only where a run of its characters does, or a long run like "a.a.a…" is scanned again from each "a".
const URLS = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()[\]{},]+|(?<![^\s"'=([,])[\w.-]+@[a-z0-9.-]+:(?!\/\/)[\w~./-][^\s"'<>()[\]{},]*/gi;
const urlsIn = (code: string) => code.replace(/\\\//g, "/").match(URLS) ?? [];

const atRegistry = ({ host, path }: { host: string; path: string }, registries: string[]) =>
  registries.some((entry) => { const slash = entry.indexOf("/"); return slash < 0 ? host === entry : `${host}${path}`.replace(/\/$/, "") === entry || `${host}${path}`.startsWith(`${entry}/`); });

/** A lockfile's digest, or null for another file, or a lockfile whose diff adds and removes no package and no host. */
export function lockfileDigest(path: string, diff: string): LockfileDigest | null {
  const format = FORMATS[FORMAT_OF[(path.split("/").pop() ?? "").toLowerCase()]];
  if (!format) return null;
  const added = new Set<string>(), removed = new Set<string>(), base = new Set<string>(), hosts = new Set<string>();
  // urlIn's object a line is in, from the last `"key": {` or `[`; unknown at a hunk's start, where its URL still counts.
  let inside: string | null = null;
  for (const row of patchRows(diff)) {
    if (row.kind === "hunk") inside = null;
    if (row.kind !== "+" && row.kind !== "-" && row.kind !== " ") continue;
    const code = row.text.slice(1);
    const name = format.name?.(code);
    if (name && row.kind !== " ") (row.kind === "+" ? added : removed).add(name);
    let urls: string[];
    if (format.url) urls = [format.url(code) ?? ""];
    else if (format.urlIn) {
      inside = code.match(/^\s*"([^"]+)"\s*:\s*[{[]/)?.[1] ?? inside;
      const url = code.match(/^\s*"url"\s*:\s*"([^"]*)"/)?.[1];
      urls = url && (inside === null || format.urlIn.includes(inside)) ? urlsIn(url) : [];
    } else urls = urlsIn(code);
    for (const url of urls) {
      const place = placeOf(url);
      if (place && !atRegistry(place, format.registries)) (row.kind === "+" ? hosts : base).add(place.host);
    }
  }
  const digest = {
    added: [...added].filter((name) => !removed.has(name)).length,
    removed: [...removed].filter((name) => !added.has(name)).length,
    hosts: [...hosts].filter((host) => !base.has(host)),
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
