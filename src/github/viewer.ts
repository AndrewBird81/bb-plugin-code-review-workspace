// Who the gh account is and which teams it's on, cached.
import { createHash } from "node:crypto";
import type { RunGh } from "./types";

export interface Viewer {
  login(): Promise<string | null>;
  teams(): Promise<ReadonlySet<string>>;
  reset(): void;
  /** Whether gh's active account changed since the last call, as `gh auth switch` outside the plugin does. Local; no API call. */
  changed?(): Promise<boolean>;
  /** What gh said when the last read of each failed; null when it succeeded. */
  errors?(): { login: string | null; teams: string | null };
}

/** Caches each read for ttlMs; after a failure returns null / an empty set until retryMs passes. */
export function createViewer(run: RunGh, options: { ttlMs?: number; retryMs?: number; now?: () => number } = {}): Viewer {
  const { ttlMs = 60 * 60_000, retryMs = 5 * 60_000, now = Date.now } = options;
  let generation = 0;

  function cached<T>(read: () => Promise<T | null>, fallback: T): () => Promise<T> {
    let entry: { value: T; until: number } | null = null;
    let pending: Promise<T> | null = null;
    let seen = generation;
    return () => {
      if (seen !== generation) { entry = null; pending = null; seen = generation; }
      if (entry && now() < entry.until) return Promise.resolve(entry.value);
      if (pending) return pending;
      const started = generation;
      const task = read().catch(() => null).then((value) => {
        // An account switch mid-read must not cache the old account.
        if (started !== generation) return value ?? fallback;
        entry = value === null ? { value: fallback, until: now() + retryMs } : { value, until: now() + ttlMs };
        pending = null;
        return entry.value;
      });
      pending = task;
      return task;
    };
  }

  const errors: { login: string | null; teams: string | null } = { login: null, teams: null };
  const failure = (out: { stderr: string; code: number }) => out.stderr.trim() || `gh exited ${out.code}`;

  const login = cached(async () => {
    const out = await run(["api", "user", "--jq", ".login"]);
    const value = out.stdout.trim();
    errors.login = out.code === 0 && value ? null : failure(out);
    return errors.login ? null : value;
  }, null as string | null);

  const teams = cached(async () => {
    const out = await run(["api", "--paginate", "user/teams", "--jq", '.[] | "\\(.organization.login)/\\(.slug)"']);
    errors.teams = out.code === 0 ? null : failure(out);
    if (out.code !== 0) return null;
    return new Set(out.stdout.split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean)) as ReadonlySet<string>;
  }, new Set<string>() as ReadonlySet<string>);

  // A hash of the active token, so the token itself isn't kept.
  let token: string | null = null;
  async function changed(): Promise<boolean> {
    const out = await run(["auth", "token", "--hostname", "github.com"]).catch(() => null);
    const value = out?.code === 0 ? out.stdout.trim() : "";
    if (!value) return false;
    const hash = createHash("sha256").update(value).digest("hex");
    const switched = token !== null && token !== hash;
    token = hash;
    return switched;
  }

  return { login, teams, reset: () => { generation++; }, changed, errors: () => ({ ...errors }) };
}
