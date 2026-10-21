// Sql (src/db/sql.ts) over Postgres, on one dedicated connection: the store's queue runs one call at a time, so a pool
// would only hold more connections. The connection is made by the first call, and again by the first call after it was
// lost; a call it was lost under fails. Host, port, user, database, password and TLS come from the options alone, which
// mirror the plugin's settings: neither the URL's query string nor pg's PG* environment variables change them, and TLS
// is built here from postgresSsl.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ConnectionOptions } from "node:tls";
import pg from "pg";
import type { Sql, SqlValue } from "./sql";

/**
 * - verify-full: TLS, with the server's certificate checked against `caPem` (Node's CAs without it) and its name against
 *   the URL's host. Channel binding is used when the server offers it.
 * - require: TLS, without checking the certificate. The password only goes to SCRAM with channel binding
 *   (SCRAM-SHA-256-PLUS), which only a server that holds the role's SCRAM secret completes, and a connection made without
 *   it is refused. This is libpq's `sslmode=require channel_binding=require`.
 * - disable: no TLS.
 */
export type PgSsl = "verify-full" | "require" | "disable";

export interface PgOptions {
  /** `postgres://user@host:port/database`: the password is `password`, and TLS is `ssl`, so the URL holds neither. */
  url: string;
  /** Read for each connection. */
  password: string | (() => string | Promise<string>);
  /** Each connection's search_path, and what the writer lock is named for. */
  schema: string;
  ssl: PgSsl;
  /** The CA certificate, PEM, that verify-full checks the server's certificate against. */
  caPem?: string;
  applicationName?: string;
  timeouts?: Partial<PgTimeouts>;
  /** The connection was lost between calls, or under one; the next call connects again. */
  onConnectionLost?(error: Error): void;
}

export interface PgTimeouts {
  /** Connecting: TCP, TLS and signing in. */
  connectMs: number;
  /** Postgres cancels a statement that runs longer (statement_timeout). */
  statementMs: number;
  /** The client gives up on a statement's answer after this, and drops the connection (pg's query_timeout). */
  queryMs: number;
  /** Postgres ends a session left idle this long inside a transaction (idle_in_transaction_session_timeout). */
  idleInTransactionMs: number;
  /**
   * TCP keepalive probes start after the connection is idle this long, from both ends. The server's (in whole seconds)
   * then probe every 5 s and give up after 3, ending a session whose client vanished, and letting its writer lock go.
   */
  keepAliveMs: number;
  /** How long taking the writer lock waits for another holder to let it go. */
  writerLockMs: number;
}

// The client's timeout outlasts the server's, so a slow statement is cancelled cleanly first.
const DEFAULT_TIMEOUTS: PgTimeouts = {
  connectMs: 10_000,
  statementMs: 30_000,
  queryMs: 35_000,
  idleInTransactionMs: 60_000,
  keepAliveMs: 10_000,
  writerLockMs: 30_000,
};

const SERVER_KEEPALIVE_INTERVAL_S = 5;
const SERVER_KEEPALIVE_COUNT = 3;
const WRITER_LOCK_POLL_MS = 100;
// How long closing waits for the server's goodbye, which a dead peer never sends.
const CLOSE_WAIT_MS = 5_000;

export interface PgSql extends Sql {
  readonly dialect: "postgres";
  /**
   * Take the single-writer lock: a session advisory lock named for the schema, waiting up to writerLockMs for another
   * holder to let it go, or throwing PgWriterLockError. From then on each new connection takes it again before
   * anything runs on it.
   */
  lockWriter(): Promise<void>;
  /** Close the connection once the running call ends. Queued and later calls reject. */
  end(): Promise<void>;
}

/** Another instance holds the writer lock on this schema. */
export class PgWriterLockError extends Error {
  constructor(schema: string, waitedMs: number) {
    super(`Another Code Review Workspace holds the writer lock on Postgres schema "${schema}" (waited ${waitedMs / 1000} s)`);
    this.name = "PgWriterLockError";
  }
}

const PLUS = "SCRAM-SHA-256-PLUS";

// Every value the store keeps in BIGINT is a ms timestamp, id or count, far below 2^53, but one past it would come back
// as a different number. pg returns int8 and numeric as text for that reason.
function exactNumber(text: string): number {
  const value = Number(text);
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Postgres returned ${text}, which a JavaScript number can't hold exactly`);
  }
  return value;
}

const types = new pg.TypeOverrides();
types.setTypeParser(pg.types.builtins.INT8, exactNumber);
types.setTypeParser(pg.types.builtins.NUMERIC, exactNumber);

const IDENTIFIER_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;
const DOLLAR_QUOTE = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

/**
 * `text` with each `?` numbered as Postgres's `$1`, `$2`, …, except inside a string, quoted identifier, dollar quote or
 * comment. The operators Postgres spells with a `?` (jsonb's) can't be written bare.
 */
export function numberPlaceholders(text: string): { text: string; count: number } {
  let numbered = "";
  let count = 0;
  let copied = 0;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    const after = text[i + 1];
    if (c === "?") {
      numbered += `${text.slice(copied, i)}$${++count}`;
      copied = ++i;
    } else if (c === "'") {
      // E'…' takes backslash escapes; an E ending an identifier is the identifier's.
      const escapes = /[Ee]/.test(text[i - 1] ?? "") && !IDENTIFIER_CHAR.test(text[i - 2] ?? "");
      i = quoteEnd(text, i, escapes);
    } else if (c === '"') {
      i = quoteEnd(text, i, false);
    } else if (c === "-" && after === "-") {
      const newline = text.indexOf("\n", i);
      i = newline < 0 ? text.length : newline + 1;
    } else if (c === "/" && after === "*") {
      i = commentEnd(text, i);
    } else if (c === "$" && !IDENTIFIER_CHAR.test(text[i - 1] ?? "")) {
      DOLLAR_QUOTE.lastIndex = i;
      const tag = DOLLAR_QUOTE.exec(text)?.[0];
      if (!tag) i++;
      else {
        const close = text.indexOf(tag, i + tag.length);
        i = close < 0 ? text.length : close + tag.length;
      }
    } else {
      i++;
    }
  }
  return { text: numbered + text.slice(copied), count };
}

/** Past the quote opened at `start`, whose quote character is doubled inside it. */
function quoteEnd(text: string, start: number, escapes: boolean): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (escapes && text[i] === "\\") i++;
    else if (text[i] === quote) {
      if (text[i + 1] !== quote) return i + 1;
      i++;
    }
  }
  return text.length;
}

/** Past the comment opened at `start`; Postgres's block comments nest. */
function commentEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "/" && text[i + 1] === "*") {
      depth++;
      i++;
    } else if (text[i] === "*" && text[i + 1] === "/") {
      i++;
      if (--depth === 0) return i + 1;
    }
  }
  return text.length;
}

interface Target { host: string; port: number; user: string; database: string }

// pg's own parser would let the URL's query override the options built here, treat sslmode=require as verify-full,
// and read certificate files the URL names. Errors never repeat the URL.
function parseUrl(url: string): Target {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("postgresUrl isn't a URL: it takes the form postgres://user@host:port/database");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("postgresUrl must start with postgres:// (postgres://user@host:port/database)");
  }
  if (parsed.password) {
    throw new Error("postgresUrl holds a password: take it out of the URL, and set it in postgresPassword, which is kept secret");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("postgresUrl takes no query parameters: TLS is set by postgresSsl (and postgresCaPem)");
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  const user = decodeURIComponent(parsed.username);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!host || !user || !database || database.includes("/")) {
    throw new Error("postgresUrl needs a user, host and database: postgres://user@host:port/database");
  }
  return { host, port: parsed.port ? Number(parsed.port) : 5432, user, database };
}

function tlsOptions(ssl: PgSsl, caPem: string | undefined): false | ConnectionOptions {
  if (caPem && ssl !== "verify-full") throw new Error("postgresCaPem is only used with postgresSsl=verify-full");
  switch (ssl) {
    case "disable": return false;
    case "require": return { rejectUnauthorized: false };
    case "verify-full": return caPem ? { rejectUnauthorized: true, ca: caPem } : { rejectUnauthorized: true };
    default: throw new Error("postgresSsl must be verify-full, require or disable");
  }
}

function unbound(serverDid: string) {
  return new Error(
    `With postgresSsl=require the server's certificate isn't checked, so the password only goes to SCRAM with channel `
    + `binding (${PLUS}), and only a server that completes it is trusted. This server ${serverDid}. `
    + "Have the role sign in with SCRAM, or use postgresSsl=verify-full.",
  );
}

// A startup option's value, in which a backslash escapes the next character and whitespace ends it.
const optionValue = (value: string) => value.replace(/[\\\s]/g, (c) => `\\${c}`);
const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const ignore = () => {};

// Whether a connection can run another statement after one failed with `error`. Postgres closes the connection after
// a FATAL error (an administrator's termination, a timeout's, a shutdown's), which can reach the statement before pg
// sees the close; pg's own failures (a lost socket, a read timeout) leave it unusable. An ordinary error, or an int8 or
// numeric refused by exactNumber, leaves it ready. The SQLSTATE classes stand in for the severity, which a server may
// translate.
export function usableAfter(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  if (!(error instanceof pg.DatabaseError)) return false;
  const code = error.code ?? "";
  return error.severity !== "FATAL" && error.severity !== "PANIC"
    && !code.startsWith("08") && !code.startsWith("57P") && code !== "25P03" && code !== "25P04";
}

/**
 * One connection, and whether it holds the writer lock. `tail` settles once the statements sent so far have answered,
 * and never rejects: a statement is only sent once the one before has answered, since pg@9 drops pg's own queue.
 */
interface Session { client: pg.Client; writer: boolean; tail: Promise<unknown> }

function send(session: Session, query: string | pg.QueryConfig): Promise<pg.QueryResult> {
  const result = session.tail.then(() => session.client.query(query));
  session.tail = result.then(ignore, ignore);
  return result;
}

/** A transaction, or a savepoint in one, while `fn` runs; `failed` is the first statement in it that failed. */
interface Frame { depth: number; open: boolean; session: Session; failed?: unknown }

/** Sql over Postgres. Nothing connects until the first call. */
export function pgSql(options: PgOptions): PgSql {
  const target = parseUrl(options.url);
  const ssl = tlsOptions(options.ssl, options.caPem);
  if (!options.schema) throw new Error("postgresSchema is empty");
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const frames = new AsyncLocalStorage<Frame>();
  // The tail of the calls from outside a transaction, each waiting for those before it: a transaction holds it until it
  // ends, so nothing else reaches its connection meanwhile.
  let lane: Promise<unknown> = Promise.resolve();
  let current: Session | null = null;
  let holdWriterLock = false;
  let closed = false;
  let ended: Promise<void> | null = null;

  function turn<T>(job: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("The Postgres connection was closed"));
    const result = lane.then(() => {
      if (closed) throw new Error("The Postgres connection was closed");
      return job();
    });
    lane = result.then(ignore, ignore);
    return result;
  }

  /** Stop using `session`, which `error` left unusable, and close it. */
  function lose(session: Session, error: unknown) {
    if (current === session) {
      current = null;
      options.onConnectionLost?.(error instanceof Error ? error : new Error(String(error)));
    }
    void close(session);
  }

  async function close(session: Session) {
    let timer: NodeJS.Timeout | undefined;
    const gone = new Promise<void>((resolve) => { timer = setTimeout(resolve, CLOSE_WAIT_MS); });
    await Promise.race([session.client.end().catch(ignore), gone]);
    clearTimeout(timer);
    session.client.connection.stream.destroy();
  }

  async function open(): Promise<Session> {
    // With require: the sign-in the server asked for, whether one was refused, and whether SCRAM completed with channel
    // binding.
    let asked: string | undefined;
    let refused: Error | undefined;
    let bound = false;
    const client = new pg.Client({
      ...target,
      password: async () => {
        if (options.ssl === "require" && (refused || asked !== PLUS)) throw refused ?? unbound(`asked for ${asked ?? "a password"}`);
        return typeof options.password === "function" ? options.password() : options.password;
      },
      ssl,
      sslnegotiation: "postgres",
      enableChannelBinding: ssl !== false,
      application_name: options.applicationName ?? "code-review-workspace",
      options: [
        `-c search_path=${optionValue(quoteIdentifier(options.schema))}`,
        `-c tcp_keepalives_idle=${Math.max(1, Math.round(timeouts.keepAliveMs / 1000))}`,
        `-c tcp_keepalives_interval=${SERVER_KEEPALIVE_INTERVAL_S}`,
        `-c tcp_keepalives_count=${SERVER_KEEPALIVE_COUNT}`,
      ].join(" "),
      statement_timeout: timeouts.statementMs,
      query_timeout: timeouts.queryMs,
      idle_in_transaction_session_timeout: timeouts.idleInTransactionMs,
      connectionTimeoutMillis: timeouts.connectMs,
      keepAlive: true,
      keepAliveInitialDelayMillis: timeouts.keepAliveMs,
      types,
    });
    const session: Session = { client, writer: false, tail: Promise.resolve() };
    if (options.ssl === "require") {
      // The one sign-in request require answers is the first, offering SCRAM-SHA-256-PLUS. pg answers any request,
      // whenever it comes, with the password it kept from the first, so a refused one is refused before pg's own
      // listener runs: once the stream is destroyed, pg writes nothing to it.
      const signIn = (method: string) => {
        const serverDid = asked !== undefined ? `asked for ${method} after signing in had begun` : method !== PLUS ? `asked for ${method}` : undefined;
        asked ??= method;
        if (serverDid === undefined) return;
        refused ??= unbound(serverDid);
        client.connection.stream.destroy(refused);
      };
      client.connection.prependListener("authenticationCleartextPassword", () => { signIn("a cleartext password"); });
      client.connection.prependListener("authenticationMD5Password", () => { signIn("an MD5 password"); });
      client.connection.prependListener("authenticationSASL", (message: { mechanisms: string[] }) => {
        signIn(message.mechanisms.includes(PLUS) ? PLUS : `SCRAM without channel binding (${message.mechanisms.join(", ")})`);
      });
      // pg checks the server's signature once this returns. Should pg rename its session, require refuses every server.
      client.connection.prependListener("authenticationSASLFinal", () => {
        bound = (client as unknown as { saslSession?: { mechanism?: string } }).saslSession?.mechanism === PLUS;
      });
    }
    client.on("error", (error) => { lose(session, error); });
    client.on("end", () => { lose(session, new Error("The connection to Postgres ended")); });
    try {
      await client.connect();
      // A server that let us in without SCRAM with channel binding, a password or none, proved nothing. pg goes on
      // reading what had arrived with a refused request, which may let it finish connecting.
      if (options.ssl === "require" && (refused || !bound)) {
        throw refused ?? unbound(asked === PLUS ? "didn't complete it" : "let the connection in without a password");
      }
    } catch (error) {
      await close(session);
      // What pg failed at once the stream was destroyed follows from the refusal.
      throw refused ?? error;
    }
    return session;
  }

  async function connection(): Promise<Session> {
    if (current) return current;
    const session = await open();
    if (holdWriterLock) {
      try {
        await takeWriterLock(session);
      } catch (error) {
        await close(session);
        throw error;
      }
    }
    current = session;
    return current;
  }

  async function takeWriterLock(session: Session) {
    const deadline = Date.now() + timeouts.writerLockMs;
    for (;;) {
      const { rows } = await execute(session, `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [`code-review-workspace:${options.schema}`]);
      if ((rows[0] as { locked: boolean } | undefined)?.locked) {
        session.writer = true;
        return;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new PgWriterLockError(options.schema, timeouts.writerLockMs);
      await sleep(Math.min(WRITER_LOCK_POLL_MS, left));
      // end() waits for this turn, so it stops waiting for the lock.
      if (closed) throw new Error("The Postgres connection was closed");
    }
  }

  async function execute(session: Session, text: string, params: readonly SqlValue[], frame?: Frame) {
    try {
      // The extended protocol for every statement, as a prepared one: one statement per text, as SQLite's prepare takes.
      return await send(session, { text, values: [...params], queryMode: "extended" } as pg.QueryConfig);
    } catch (error) {
      if (frame) frame.failed ??= error;
      if (!usableAfter(error)) lose(session, error);
      throw error;
    }
  }

  function statement(text: string, params: readonly SqlValue[]) {
    const numbered = numberPlaceholders(text);
    if (numbered.count !== params.length) {
      return Promise.reject(new RangeError(`The statement has ${numbered.count} ? placeholders, and was given ${params.length} values`));
    }
    const frame = frames.getStore();
    if (frame?.open) return execute(frame.session, numbered.text, params, frame);
    return turn(async () => execute(await connection(), numbered.text, params));
  }

  /** End a transaction or savepoint after a failure, which is the error to report: if this fails too, the connection is dropped. */
  async function rollback(session: Session, text: string) {
    try {
      await send(session, text);
    } catch (error) {
      lose(session, error);
    }
  }

  // Postgres refuses every statement in a transaction after one fails, and turns its COMMIT into a ROLLBACK.
  const aborted = (failed: unknown) => new Error(
    "Postgres rolled the transaction back: a statement in it failed, which aborts a Postgres transaction, and it went on",
    { cause: failed },
  );

  /** `fn` in `frame`, which closes as soon as `fn` settles: what `fn` left running then waits like any call from outside. */
  async function runIn<T>(frame: Frame, fn: () => Promise<T>): Promise<T> {
    try {
      return await frames.run(frame, fn);
    } finally {
      frame.open = false;
    }
  }

  async function savepoint<T>(parent: Frame, fn: () => Promise<T>): Promise<T> {
    const { session } = parent;
    const name = `sql_savepoint_${parent.depth + 1}`;
    await execute(session, `SAVEPOINT ${name}`, [], parent);
    const frame: Frame = { depth: parent.depth + 1, open: true, session };
    let result: T;
    try {
      result = await runIn(frame, fn);
    } catch (error) {
      await rollback(session, `ROLLBACK TO SAVEPOINT ${name}`);
      await rollback(session, `RELEASE SAVEPOINT ${name}`);
      throw error;
    }
    if (frame.failed !== undefined) {
      await rollback(session, `ROLLBACK TO SAVEPOINT ${name}`);
      await rollback(session, `RELEASE SAVEPOINT ${name}`);
      throw aborted(frame.failed);
    }
    await execute(session, `RELEASE SAVEPOINT ${name}`, [], parent);
    return result;
  }

  async function transaction<T>(fn: () => Promise<T>): Promise<T> {
    const session = await connection();
    await execute(session, "BEGIN", []);
    const frame: Frame = { depth: 0, open: true, session };
    let result: T;
    try {
      result = await runIn(frame, fn);
    } catch (error) {
      await rollback(session, "ROLLBACK");
      throw error;
    }
    if (frame.failed !== undefined) {
      await rollback(session, "ROLLBACK");
      throw aborted(frame.failed);
    }
    const { command } = await execute(session, "COMMIT", []);
    if (command !== "COMMIT") throw aborted(undefined);
    return result;
  }

  return {
    dialect: "postgres",
    async all<T>(text: string, params: readonly SqlValue[] = []) {
      return (await statement(text, params)).rows as T[];
    },
    async get<T>(text: string, params: readonly SqlValue[] = []) {
      return (await statement(text, params)).rows[0] as T | undefined;
    },
    async run(text: string, params: readonly SqlValue[] = []) {
      return { changes: (await statement(text, params)).rowCount ?? 0 };
    },
    transaction<T>(fn: () => Promise<T>) {
      const parent = frames.getStore();
      if (parent?.open) return savepoint(parent, fn);
      return turn(() => transaction(fn));
    },
    lockWriter() {
      return turn(async () => {
        const session = await connection();
        if (!session.writer) await takeWriterLock(session);
        holdWriterLock = true;
      });
    },
    end() {
      ended ??= (async () => {
        closed = true;
        await lane;
        const session = current;
        current = null;
        if (session) await close(session);
      })();
      return ended;
    },
  };
}
