// Where the Store keeps its tables: SQLite, in the plugin's own data.db, or Postgres, as the plugin's settings choose.
// The kv marker storage:owner names the one that holds this install's reviews; the storage CLI moves them and it. Until
// the settings and the marker agree, and the Postgres settings are complete, the plugin is in maintenance: it serves its
// CLI and nothing else, and never falls back to SQLite. Settings apply when the plugin loads.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import pg from "pg";
import { pgSql, PgWriterLockError, type PgOptions, type PgSql, type PgSsl } from "./db/pg";

export const STORAGE_OWNER_KEY = "storage:owner";

type Backend = "sqlite" | "postgres";

const BACKENDS: readonly Backend[] = ["sqlite", "postgres"];

function defineStorageSettings(bb: BbPluginApi) {
  return bb.settings.define({
    storageBackend: {
      type: "select", label: "Storage", options: ["sqlite", "postgres"], default: "sqlite",
      description: "Where the reviews are kept: SQLite, in BB's data directory, or Postgres. The reviews move with bb review storage, then a reload.",
    },
    postgresUrl: {
      type: "string", label: "Postgres URL",
      description: "postgres://user@host:port/database, with no password and no query parameters.",
    },
    postgresPassword: { type: "string", label: "Postgres password", secret: true },
    postgresSchema: {
      type: "string", label: "Postgres schema", default: "code_review_workspace",
      description: "The schema the tables are made in, created if it's missing.",
    },
    postgresSsl: {
      type: "select", label: "Postgres TLS", options: ["verify-full", "require", "disable"], default: "require",
      description: "verify-full checks the server's certificate. require doesn't, and signs in only with SCRAM channel binding. disable sends everything in the clear, for local development.",
    },
    postgresCaPem: {
      type: "string", label: "Postgres CA certificate", experimental_multiline: true,
      description: "PEM, which verify-full checks the server's certificate against; without it, Node's CAs.",
    },
  });
}

export type StorageSettings = Awaited<ReturnType<ReturnType<typeof defineStorageSettings>["get"]>>;

/** What bb review storage status reports. */
export interface StorageStatus {
  /** storageBackend, as the settings have it. */
  readonly configured: string;
  /** What storage:owner names: the backend holding the reviews. The storage CLI's migrate and export-sqlite move it. */
  owner: string;
  /** maintenance: only the CLI serves. opening: Postgres is being opened, at activation. */
  state: "maintenance" | "opening" | "serving";
  /** Why it isn't serving: maintenance's reason, or opening's latest failure. */
  problem: string | null;
}

export type StorageChoice =
  | { kind: "maintenance"; status: StorageStatus; settings: StorageSettings }
  | { kind: "sqlite"; status: StorageStatus; settings: StorageSettings }
  | { kind: "postgres"; status: StorageStatus; settings: StorageSettings; pg: PgSql; schema: string; redact(text: string): string };

/** pgSql's options from the settings, or a plain Error naming the setting that's missing or wrong. */
export function pgOptions(settings: StorageSettings, onConnectionLost?: PgOptions["onConnectionLost"]): PgOptions {
  if (!settings.postgresUrl) throw new Error("postgresUrl is not set: postgres://user@host:port/database");
  if (!settings.postgresPassword) throw new Error("postgresPassword is not set");
  return {
    url: settings.postgresUrl, password: settings.postgresPassword, schema: settings.postgresSchema,
    ssl: settings.postgresSsl as PgSsl, ...(settings.postgresCaPem ? { caPem: settings.postgresCaPem } : {}), onConnectionLost,
  };
}

/** `text` without the Postgres URL or password, which no log or status shows. */
export function redactor(settings: StorageSettings) {
  const secrets = [settings.postgresUrl, settings.postgresPassword].filter((secret): secret is string => !!secret);
  return (text: string) => secrets.reduce((redacted, secret) => redacted.replaceAll(secret, "[redacted]"), text);
}

/**
 * Define the storage settings and choose the backend from them and storage:owner. Reads bb.db alone, so the factory
 * can call it while the instance a reload replaces still holds Postgres: a Postgres choice has connected to nothing.
 */
export async function chooseStorage(bb: BbPluginApi): Promise<StorageChoice> {
  const defined = defineStorageSettings(bb);
  defined.onChange(() => { bb.log.info(`Storage settings changed: they apply once the plugin reloads (bb plugin reload ${bb.pluginId}).`); });
  const settings = await defined.get();
  const marked = await bb.storage.kv.get<unknown>(STORAGE_OWNER_KEY);
  // Every install before Postgres kept its reviews in SQLite.
  const owner = marked ?? "sqlite";
  const status: StorageStatus = { configured: settings.storageBackend, owner: typeof owner === "string" ? owner : JSON.stringify(owner), state: "maintenance", problem: null };
  const reload = `bb plugin reload ${bb.pluginId}`;
  const maintenance = (problem: string): StorageChoice => {
    status.problem = problem;
    return { kind: "maintenance", status, settings };
  };
  if (!BACKENDS.includes(owner as Backend)) {
    return maintenance(`Code Review Workspace's reviews are marked as kept in ${status.owner} (${STORAGE_OWNER_KEY}), which this version doesn't know: update the plugin.`);
  }
  if (settings.storageBackend !== owner) {
    return maintenance(owner === "sqlite"
      ? `Code Review Workspace's storage is set to Postgres, but its reviews are in SQLite. Run bb review storage migrate to copy them to Postgres, then ${reload}. To stay on SQLite, set storageBackend back to sqlite and reload.`
      : `Code Review Workspace's storage is set to SQLite, but its reviews are in Postgres. Set storageBackend back to postgres and reload (${reload}), or run bb review storage export-sqlite --replace-data-db to copy them to SQLite first.`);
  }
  if (owner === "sqlite") return { kind: "sqlite", status: { ...status, state: "serving" }, settings };
  const redact = redactor(settings);
  let connection: PgSql;
  try {
    connection = pgSql(pgOptions(settings, (error) => {
      bb.log.warn(`Lost the connection to Postgres: ${redact(String(error))}. The next store call connects again.`);
    }));
  } catch (error) {
    return maintenance(`Code Review Workspace can't use Postgres: ${redact(error instanceof Error ? error.message : String(error))}. Fix the setting, then ${reload}.`);
  }
  status.state = "opening";
  return { kind: "postgres", status, settings, pg: connection, schema: settings.postgresSchema, redact };
}

/** Errors that say only that Postgres can't be reached yet: from the network, or from a server starting or stopping. */
const UNREACHABLE = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

export function unreachable(error: unknown): boolean {
  if (error instanceof AggregateError && error.errors.length) return error.errors.every(unreachable);
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (UNREACHABLE.has(code) || code.startsWith("08") || code.startsWith("57P"))) return true;
  // pg's own: its connect timeout, and a server that closed the connection.
  return error.message === "timeout expired" || error.message === "Connection terminated unexpectedly";
}

export function describe(error: unknown): string {
  if (error instanceof pg.DatabaseError) return `Postgres answered: ${error.message} (SQLSTATE ${error.code})`;
  if (error instanceof PgWriterLockError) return `${error.message}. Stop the other BB using this schema, or give this one a schema of its own (postgresSchema)`;
  if (error instanceof AggregateError && error.errors.length) return error.errors.map(describe).join("; ");
  return error instanceof Error ? error.message : String(error);
}

export interface OpenTiming {
  /** The wait after the first failure, doubling after each one after it. */
  firstRetryMs: number;
  maxRetryMs: number;
  /** How long Postgres may be out of reach, as after a power cut that BB came back from first, before it's reported. */
  unreachableGraceMs: number;
}

const OPEN_TIMING: OpenTiming = { firstRetryMs: 1_000, maxRetryMs: 60_000, unreachableGraceMs: 60_000 };

/** A promise that settles when `ms` passes or `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** `attempt`'s value, or null as soon as `signal` aborts: what it leaves running settles unheard. */
export function unlessAborted<T>(attempt: Promise<T>, signal: AbortSignal): Promise<T | null> {
  attempt.catch(() => {});
  return Promise.race([attempt, new Promise<null>((resolve) => {
    if (signal.aborted) resolve(null);
    signal.addEventListener("abort", () => { resolve(null); }, { once: true });
  })]);
}

/**
 * Open Postgres storage with `open`, trying again until it works, waiting twice as long after each failure up to
 * maxRetryMs, or until `signal` aborts, which returns null at once. Each failure is logged and becomes the status's
 * problem. needsConfiguration hears it, without the URL or password, unless Postgres has only been out of reach for less
 * than unreachableGraceMs. BB keeps that status until the plugin reloads, even once a later try gets through.
 */
export async function openPostgres<T>(
  bb: BbPluginApi,
  storage: Extract<StorageChoice, { kind: "postgres" }>,
  signal: AbortSignal,
  open: () => Promise<T>,
  timing: OpenTiming = OPEN_TIMING,
): Promise<T | null> {
  const { status, redact } = storage;
  let retryMs = timing.firstRetryMs;
  let unreachableSince: number | null = null;
  let reported: string | null = null;
  for (;;) {
    status.state = "opening";
    let opened: T | null;
    try {
      opened = await unlessAborted(open(), signal);
    } catch (error) {
      if (signal.aborted) return null;
      const problem = redact(describe(error));
      status.problem = problem;
      const now = Date.now();
      unreachableSince = unreachable(error) ? unreachableSince ?? now : null;
      bb.log.warn(`Could not open Code Review Workspace's Postgres storage: ${problem}. Trying again in ${retryMs / 1000} s.`);
      if ((unreachableSince === null || now - unreachableSince >= timing.unreachableGraceMs) && problem !== reported) {
        reported = problem;
        bb.status.needsConfiguration(`Code Review Workspace can't open its Postgres storage: ${problem}. It keeps trying, and serves once it gets through; this status stays until the plugin reloads (bb plugin reload ${bb.pluginId}).`);
      }
      await pause(retryMs, signal);
      if (signal.aborted) return null;
      retryMs = Math.min(retryMs * 2, timing.maxRetryMs);
      continue;
    }
    if (opened === null) return null;
    status.state = "serving";
    status.problem = null;
    if (reported) bb.log.info(`Code Review Workspace's Postgres storage is open. Its needs-configuration status stays until the plugin reloads (bb plugin reload ${bb.pluginId}).`);
    return opened;
  }
}
