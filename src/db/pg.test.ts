import { randomBytes } from "node:crypto";
import type { TLSSocket } from "node:tls";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { numberPlaceholders, pgSql, PgWriterLockError, type PgOptions, type PgSql } from "./pg";

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

test("each ? outside a string, quoted identifier, dollar quote or comment is numbered in order", () => {
  const cases: Array<[string, string, number]> = [
    ["SELECT a FROM t WHERE b=? AND c IN (?,?)", "SELECT a FROM t WHERE b=$1 AND c IN ($2,$3)", 3],
    ["SELECT '?', 'it''s ?', ? FROM t", "SELECT '?', 'it''s ?', $1 FROM t", 1],
    [`SELECT "a?b", "say ""?""" FROM t WHERE x=?`, `SELECT "a?b", "say ""?""" FROM t WHERE x=$1`, 1],
    ["SELECT E'\\'?', E'\\\\', ? FROM t", "SELECT E'\\'?', E'\\\\', $1 FROM t", 1],
    // An E ending an identifier isn't an escape string's: its backslash is a plain character.
    ["SELECT typE'\\', ?", "SELECT typE'\\', $1", 1],
    ["SELECT ? -- what?\n, ? /* why? /* nested? */ still? */ , ?", "SELECT $1 -- what?\n, $2 /* why? /* nested? */ still? */ , $3", 3],
    ["SELECT $$?$$, $tag$ ? $other$ ? $tag$, ?", "SELECT $$?$$, $tag$ ? $other$ ? $tag$, $1", 1],
    // A $ inside an identifier doesn't open a dollar quote.
    ["SELECT a$b$ FROM t WHERE c=?", "SELECT a$b$ FROM t WHERE c=$1", 1],
    ["SELECT x::text FROM t WHERE y=?::int", "SELECT x::text FROM t WHERE y=$1::int", 1],
    ["SELECT 1", "SELECT 1", 0],
    // Unterminated: copied as written, for Postgres to reject.
    ["SELECT 'open ? FROM t", "SELECT 'open ? FROM t", 0],
  ];
  for (const [text, numbered, count] of cases) expect(numberPlaceholders(text), text).toEqual({ text: numbered, count });
});

describe("the options, checked before anything connects", () => {
  const options = { password: "secret", schema: "code_review_workspace", ssl: "require" } as const;

  test("a password or query parameter in the URL is refused, naming the setting to use, without repeating the URL", () => {
    const refusals: Array<[string, RegExp]> = [
      ["postgres://crw:hunter2@db.example:5432/crw", /postgresPassword/],
      ["postgres://crw@db.example:5432/crw?sslmode=disable", /postgresSsl/],
      ["postgres://crw@db.example:5432/crw?sslrootcert=/etc/hunter2.pem", /postgresSsl/],
      ["mysql://crw@db.example/crw", /postgres:\/\//],
      ["crw@db.example:5432/crw", /isn't a URL/],
      ["postgres://db.example:5432/crw", /user, host and database/],
      ["postgres://crw@db.example:5432/", /user, host and database/],
    ];
    for (const [url, setting] of refusals) {
      let message = "";
      try {
        pgSql({ ...options, url });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, url).toMatch(setting);
      expect(message).not.toContain("hunter2");
      expect(message).not.toContain("db.example");
    }
  });

  test("a CA is only taken with verify-full, a mode must be one of the three, and the schema can't be empty", () => {
    const url = "postgres://crw@db.example/crw";
    expect(() => pgSql({ ...options, url, caPem: "PEM" })).toThrow("postgresCaPem is only used with postgresSsl=verify-full");
    expect(() => pgSql({ ...options, url, ssl: "prefer" as "require" })).toThrow("postgresSsl must be verify-full, require or disable");
    expect(() => pgSql({ ...options, url, schema: "" })).toThrow("postgresSchema is empty");
    expect(() => pgSql({ ...options, url: "postgresql://crw@[::1]:6543/crw", ssl: "verify-full", caPem: "PEM" })).not.toThrow();
  });
});

const testUrl = process.env.CRW_TEST_PG_URL;

// Postgres from CRW_TEST_PG_URL (postgres://user:password@host:port/database), which scripts/test-postgres.sh starts.
describe.skipIf(!testUrl)("against Postgres (CRW_TEST_PG_URL)", () => {
  const parsed = new URL(testUrl ?? "postgres://unset@localhost/unset");
  const server = {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)),
  };
  const urlFor = (user: string, host = server.host) => `postgres://${user}@${host}:${server.port}/${server.database}`;
  const admin = new pg.Client({ ...server, ssl: { rejectUnauthorized: false } });
  let caPem = "";
  // The roles and certificate scripts/test-postgres.sh sets up, which the sign-in and certificate tests need.
  let testContainer = false;
  const opened: PgSql[] = [];
  const schemas: string[] = [];

  beforeAll(async () => {
    await admin.connect();
    const der = (admin.connection.stream as TLSSocket).getPeerCertificate().raw.toString("base64");
    caPem = `-----BEGIN CERTIFICATE-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_roles WHERE rolname IN ('crw_md5', 'crw_password', 'crw_trust')`);
    testContainer = rows[0]?.n === "3" && server.host === "localhost";
  });

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((sql) => sql.end()));
    for (const schema of schemas.splice(0)) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  });

  afterAll(async () => {
    await admin.end();
  });

  async function newSchema() {
    const schema = `crw_p7_${randomBytes(6).toString("hex")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    schemas.push(schema);
    return schema;
  }

  function connect(options: Partial<PgOptions> & { schema: string }) {
    const sql = pgSql({ url: urlFor(server.user), password: server.password, ssl: "require", ...options });
    opened.push(sql);
    return sql;
  }

  /** A connection to a new schema holding `notes`, whose body can't be "invalid". */
  async function notes(options: Partial<PgOptions> = {}) {
    const schema = await newSchema();
    const sql = connect({ schema, ...options });
    await sql.run(`CREATE TABLE notes (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, body TEXT NOT NULL CHECK (body <> 'invalid'))`);
    const bodies = async () => (await sql.all<{ body: string }>(`SELECT body FROM notes ORDER BY id`)).map((row) => row.body);
    return { schema, sql, bodies, add: (body: string) => sql.run(`INSERT INTO notes (body) VALUES (?)`, [body]) };
  }

  const pid = async (sql: PgSql) => (await sql.get<{ pid: number }>(`SELECT pg_backend_pid() AS pid`))!.pid;
  const terminate = (backend: number) => admin.query(`SELECT pg_terminate_backend($1)`, [backend]);
  const holdsWriterLock = async (backend: number) =>
    (await admin.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND pid=$1`, [backend])).rowCount === 1;

  describe("connecting", () => {
    test("require: TLS, SCRAM with channel binding, in the schema, named, with each timeout set", async () => {
      const sent = vi.spyOn(pg.Connection.prototype as unknown as { sendSASLInitialResponseMessage(mechanism: string): void }, "sendSASLInitialResponseMessage");
      const password = vi.fn(() => server.password);
      const schema = await newSchema();
      const sql = connect({ schema, password, timeouts: { statementMs: 12_000, idleInTransactionMs: 34_000 } });
      try {
        expect(await sql.get(`SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()`)).toEqual({ ssl: true, version: "TLSv1.3" });
        expect(sent.mock.calls.map(([mechanism]) => mechanism)).toEqual(["SCRAM-SHA-256-PLUS"]);
        expect(password).toHaveBeenCalledTimes(1);
        expect(await sql.get(`SELECT current_schema() AS schema, current_setting('application_name') AS name,
          current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle`))
          .toEqual({ schema, name: "code-review-workspace", statement: "12s", idle: "34s" });
      } finally {
        sent.mockRestore();
      }
    });

    test("verify-full checks the certificate against postgresCaPem and the host's name, and still binds the channel", async ({ skip }) => {
      if (!testContainer) skip("needs the certificate for localhost that scripts/test-postgres.sh makes");
      const sent = vi.spyOn(pg.Connection.prototype as unknown as { sendSASLInitialResponseMessage(mechanism: string): void }, "sendSASLInitialResponseMessage");
      const schema = await newSchema();
      try {
        const verified = connect({ schema, ssl: "verify-full", caPem });
        expect(await verified.get(`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`)).toEqual({ ssl: true });
        expect(sent.mock.calls.map(([mechanism]) => mechanism)).toEqual(["SCRAM-SHA-256-PLUS"]);
      } finally {
        sent.mockRestore();
      }
      // Self-signed, so Node's own CAs don't vouch for it.
      await expect(connect({ schema, ssl: "verify-full" }).get(`SELECT 1`)).rejects.toThrow(/self[- ]signed/);
      // The certificate names localhost, not 127.0.0.1.
      await expect(connect({ schema, ssl: "verify-full", caPem, url: urlFor(server.user, "127.0.0.1") }).get(`SELECT 1`))
        .rejects.toThrow(/IP: 127\.0\.0\.1 is not in the cert's list/);
    });

    test("a schema whose name needs quoting, with a space, a quote and a backslash, is the search_path as written", async () => {
      const schema = `Crw ${randomBytes(3).toString("hex")} "q" \\`;
      await admin.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      try {
        const sql = connect({ schema });
        await sql.run(`CREATE TABLE here (id INTEGER)`);
        expect(await sql.get(`SELECT current_schema() AS schema`)).toEqual({ schema });
        expect((await admin.query(`SELECT 1 FROM pg_tables WHERE schemaname=$1 AND tablename='here'`, [schema])).rowCount).toBe(1);
        await sql.end();
      } finally {
        await admin.query(`DROP SCHEMA ${pg.escapeIdentifier(schema)} CASCADE`);
      }
    });

    test("disable connects without TLS", async () => {
      const sql = connect({ schema: await newSchema(), ssl: "disable" });
      expect(await sql.get(`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`)).toEqual({ ssl: false });
    });

    test("require refuses a server asking for an MD5 or cleartext password, or none, and never reads the password", async ({ skip }) => {
      if (!testContainer) skip("needs the crw_md5, crw_password and crw_trust roles that scripts/test-postgres.sh makes");
      const schema = await newSchema();
      const refusals: Array<[string, RegExp]> = [
        ["crw_md5", /asked for an MD5 password/],
        ["crw_password", /asked for a cleartext password/],
        ["crw_trust", /let the connection in without a password/],
      ];
      for (const [role, refusal] of refusals) {
        const password = vi.fn(() => role);
        await expect(connect({ schema, url: urlFor(role), password }).get(`SELECT 1`), role).rejects.toThrow(refusal);
        expect(password, role).not.toHaveBeenCalled();
        // The roles sign in when the certificate is checked instead, so it's require that refused them.
        const verified = connect({ schema, url: urlFor(role), password, ssl: "verify-full", caPem });
        expect(await verified.get(`SELECT current_user AS role`), role).toEqual({ role });
      }
    });

    test("require refuses a request to sign in again, once SCRAM with channel binding has begun, before pg answers it", async () => {
      const schema = await newSchema();
      // What a man in the middle could ask for after offering SCRAM-SHA-256-PLUS: the password itself, an MD5 hash it
      // chose the salt for, or a second SCRAM exchange.
      const requests: Array<[string, object, RegExp]> = [
        ["authenticationCleartextPassword", { name: "authenticationCleartextPassword", length: 8 }, /asked for a cleartext password after signing in had begun/],
        ["authenticationMD5Password", { name: "authenticationMD5Password", length: 12, salt: Buffer.alloc(4) }, /asked for an MD5 password after signing in had begun/],
        ["authenticationSASL", { name: "authenticationSASL", length: 23, mechanisms: ["SCRAM-SHA-256-PLUS"] }, /asked for SCRAM-SHA-256-PLUS after signing in had begun/],
      ];
      type Sending = pg.Connection & { sendSASLInitialResponseMessage(mechanism: string, response: string): void };
      const prototype = pg.Connection.prototype as Sending;
      const initial = prototype.sendSASLInitialResponseMessage;
      for (const [event, message, refusal] of requests) {
        const password = vi.fn(() => server.password);
        let written: ReturnType<typeof vi.fn> | undefined;
        const sent = vi.spyOn(prototype, "sendSASLInitialResponseMessage").mockImplementationOnce(function (this: Sending, mechanism, response) {
          initial.call(this, mechanism, response);
          written = vi.spyOn(this.stream, "write") as unknown as ReturnType<typeof vi.fn>;
          this.emit(event, message);
        });
        try {
          await expect(connect({ schema, password }).get(`SELECT 1`), event).rejects.toThrow(refusal);
          // pg hashes the MD5 answer asynchronously.
          await sleep(50);
          expect(written, event).toBeDefined();
          expect(written, event).not.toHaveBeenCalled();
          expect(password, event).toHaveBeenCalledTimes(1);
        } finally {
          sent.mockRestore();
        }
      }
    });

    test("a wrong password fails to sign in", async () => {
      const sql = connect({ schema: await newSchema(), password: "wrong" });
      await expect(sql.get(`SELECT 1`)).rejects.toThrow(/password authentication failed/);
    });
  });

  describe("statements", () => {
    test("all, get and run take ? parameters; run counts the rows it changed, and ON CONFLICT DO NOTHING none", async () => {
      const { sql, add } = await notes();
      expect(sql.dialect).toBe("postgres");
      expect(await add("a")).toEqual({ changes: 1 });
      await add("b");
      expect(await sql.all(`SELECT id, body FROM notes WHERE id >= ? ORDER BY id`, [1])).toEqual([{ id: 1, body: "a" }, { id: 2, body: "b" }]);
      expect(await sql.get(`SELECT body FROM notes WHERE id=?`, [2])).toEqual({ body: "b" });
      expect(await sql.get(`SELECT body FROM notes WHERE id=?`, [3])).toBeUndefined();
      expect(await sql.run(`UPDATE notes SET body=? WHERE id <= ?`, ["c", 2])).toEqual({ changes: 2 });
      expect(await sql.run(`INSERT INTO notes (id, body) VALUES (1, 'd') ON CONFLICT DO NOTHING`)).toEqual({ changes: 0 });
      expect(await sql.run(`DELETE FROM notes WHERE body=?`, ["none"])).toEqual({ changes: 0 });
    });

    test("a ? inside a string, quoted identifier, comment or dollar quote reaches Postgres as written", async () => {
      const { sql } = await notes();
      expect(await sql.get(`SELECT ? AS "what?", '?''?' AS quoted, E'\\'?' AS escaped, $$?$$ AS dollar, ? AS last -- ?\n/* ? */`, ["a", "b"]))
        .toEqual({ "what?": "a", quoted: "?'?", escaped: "'?", dollar: "?", last: "b" });
    });

    test("a statement with more or fewer values than placeholders is refused before it is sent", async () => {
      const { sql } = await notes();
      await expect(sql.get(`SELECT ? AS a`, [])).rejects.toThrow("The statement has 1 ? placeholders, and was given 0 values");
      await expect(sql.get(`SELECT 1 AS a`, [1])).rejects.toThrow("The statement has 0 ? placeholders, and was given 1 values");
    });

    test("one statement per call, as SQLite's prepare takes", async () => {
      const { sql } = await notes();
      await expect(sql.run(`SELECT 1; SELECT 2`)).rejects.toThrow(/cannot insert multiple commands into a prepared statement/);
    });

    test("bigint and numeric come back as numbers, and one a number can't hold exactly fails rather than rounding", async () => {
      const { sql } = await notes();
      const now = 1792524726294;
      expect(await sql.get(`SELECT ?::bigint AS at, count(*) AS n, sum(id) AS total, 2.5::numeric AS half FROM notes`, [now]))
        .toEqual({ at: now, n: 0, total: null, half: 2.5 });
      const max = Number.MAX_SAFE_INTEGER;
      expect(await sql.get(`SELECT ${max}::bigint AS top, -${max}::bigint AS bottom, ${max}::numeric AS n`)).toEqual({ top: max, bottom: -max, n: max });
      await expect(sql.get(`SELECT 9007199254740993::bigint AS past`)).rejects.toThrow("Postgres returned 9007199254740993, which a JavaScript number can't hold exactly");
      await expect(sql.get(`SELECT -9007199254740992::bigint AS past`)).rejects.toThrow(RangeError);
      await expect(sql.get(`SELECT 9007199254740992::numeric AS past`)).rejects.toThrow(RangeError);
      // The connection carries on.
      expect(await sql.get(`SELECT 1 AS one`)).toEqual({ one: 1 });
    });

    test("the statements whose parameter types Postgres infers apart from SQLite run as the store writes them", async () => {
      const { sql } = await notes();
      await sql.run(`CREATE TABLE entries (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, line INTEGER NOT NULL, start_line INTEGER)`);
      await sql.run(`INSERT INTO entries (line, start_line) VALUES (5, 3), (6, NULL), (7, 4)`);
      // rebaseDraftComments: an explicit start line, or the old one moved by the line's shift.
      const move = `UPDATE entries SET line=?, start_line=CASE WHEN start_line IS NULL THEN NULL ELSE COALESCE(?, start_line + ?) END WHERE id=?`;
      await sql.run(move, [15, null, 10, 1]);
      await sql.run(move, [16, null, 10, 2]);
      await sql.run(move, [17, 2, 10, 3]);
      expect(await sql.all(`SELECT line, start_line FROM entries ORDER BY id`)).toEqual([
        { line: 15, start_line: 13 }, { line: 16, start_line: null }, { line: 17, start_line: 2 },
      ]);
      // recordAgentOutcomes: keep the newest rows.
      expect(await sql.run(`DELETE FROM entries WHERE id <= (SELECT id FROM entries ORDER BY id DESC LIMIT 1 OFFSET ?)`, [1])).toEqual({ changes: 2 });
      // listDiscussions: whether any row of either kind exists.
      expect(await sql.get(`SELECT 1 AS found FROM entries WHERE line=? UNION ALL SELECT 1 FROM notes WHERE body=? LIMIT 1`, [17, "none"])).toEqual({ found: 1 });
      // ON CONFLICT DO NOTHING without a target, on a composite key.
      await sql.run(`CREATE TABLE waits (target_key TEXT NOT NULL, line INTEGER NOT NULL, PRIMARY KEY (target_key, line))`);
      const wait = `INSERT INTO waits (target_key,line) VALUES (?,?) ON CONFLICT DO NOTHING`;
      expect([await sql.run(wait, ["k", 1]), await sql.run(wait, ["k", 1])]).toEqual([{ changes: 1 }, { changes: 0 }]);
    });
  });

  describe("transactions", () => {
    test("a transaction commits once its function resolves, and gives its result; one that throws rolls back", async () => {
      const { sql, add, bodies } = await notes();
      await expect(sql.transaction(async () => {
        await add("a");
        await add("b");
        return "done";
      })).resolves.toBe("done");
      await expect(sql.transaction(async () => {
        await add("c");
        await sleep(5);
        throw new Error("no");
      })).rejects.toThrow("no");
      expect(await bodies()).toEqual(["a", "b"]);
    });

    test("a nested transaction that throws rolls back only its own writes, and the outer one, catching it, commits the rest", async () => {
      const { sql, add, bodies } = await notes();
      await sql.transaction(async () => {
        await add("outer before");
        await expect(sql.transaction(async () => {
          await add("inner");
          await sql.transaction(async () => { await add("innermost"); });
          throw new Error("inner failed");
        })).rejects.toThrow("inner failed");
        await sql.transaction(async () => { await add("second inner"); });
        await add("outer after");
      });
      expect(await bodies()).toEqual(["outer before", "second inner", "outer after"]);
    });

    test("a nested transaction's throw that the outer one doesn't catch rolls everything back, its released savepoints too", async () => {
      const { sql, add, bodies } = await notes();
      await expect(sql.transaction(async () => {
        await add("outer");
        await sql.transaction(async () => { await add("released"); });
        await sql.transaction(async () => {
          await add("inner");
          throw new Error("inner failed");
        });
      })).rejects.toThrow("inner failed");
      expect(await bodies()).toEqual([]);
    });

    test("savepoints rolled back alone are released, so the next nests at the same depth", async () => {
      const { sql, add, bodies } = await notes();
      await sql.transaction(async () => {
        for (const body of ["x", "y"]) {
          await sql.transaction(async () => { await add(body); throw new Error(body); }).catch(() => undefined);
        }
        await sql.transaction(async () => {
          await add("z");
          await sql.transaction(async () => { await add("deeper"); throw new Error("deeper"); }).catch(() => undefined);
        });
      });
      expect(await bodies()).toEqual(["z"]);
    });

    test("a failed statement aborts the transaction: what follows it fails, and it rolls back even when its function carries on", async () => {
      const { sql, add, bodies } = await notes();
      let after: unknown;
      const failed = sql.transaction(async () => {
        await add("kept until the end");
        await expect(add("invalid")).rejects.toThrow(/violates check constraint/);
        after = await add("after").catch((error: unknown) => error);
        return "carried on";
      });
      const error = await failed.then(() => undefined, (rejection: unknown) => rejection as Error);
      expect(error?.message).toMatch("Postgres rolled the transaction back: a statement in it failed");
      // The first failure, a check_violation; what followed it was refused as in_failed_sql_transaction.
      expect(error?.cause).toMatchObject({ code: "23514" });
      expect(after).toMatchObject({ code: "25P02" });
      expect(await bodies()).toEqual([]);
    });

    test("a failed statement in a nested transaction aborts only it, whether or not its function carries on", async () => {
      const { sql, add, bodies } = await notes();
      await sql.transaction(async () => {
        await add("outer");
        await expect(sql.transaction(async () => {
          await add("inner");
          await add("invalid").catch(() => undefined);
        })).rejects.toThrow("Postgres rolled the transaction back");
        await expect(sql.transaction(async () => {
          await add("inner too");
          await add("invalid");
        })).rejects.toThrow(/violates check constraint/);
        await add("outer after");
      });
      expect(await bodies()).toEqual(["outer", "outer after"]);
    });

    test("statements a transaction starts without awaiting each go to Postgres once the one before has answered, in order", async () => {
      const { sql, add, bodies } = await notes();
      const warnings = vi.spyOn(process, "emitWarning");
      try {
        await sql.transaction(async () => {
          await Promise.all(["a", "b", "c", "d", "e"].map((body) => add(body)));
        });
        // pg warns of a query sent while another runs, which pg@9 won't queue.
        expect(warnings.mock.calls.map(([warning]) => String(warning))).not.toContainEqual(expect.stringContaining("already executing a query"));
      } finally {
        warnings.mockRestore();
      }
      expect(await bodies()).toEqual(["a", "b", "c", "d", "e"]);
    });

    test("a statement from outside an open transaction waits for it to end, so a rollback doesn't take it", async () => {
      const { sql, add, bodies } = await notes();
      const order: string[] = [];
      const failing = sql.transaction(async () => {
        await add("rolled back");
        order.push("transaction wrote");
        await sleep(20);
        order.push("transaction throws");
        throw new Error("no");
      });
      await sleep(5);
      const outside = add("outside").then(() => { order.push("outside wrote"); });
      await expect(failing).rejects.toThrow("no");
      await outside;
      expect(order).toEqual(["transaction wrote", "transaction throws", "outside wrote"]);
      expect(await bodies()).toEqual(["outside"]);
    });

    test("transactions started together run one after the other, each committing or rolling back alone", async () => {
      const { sql, add, bodies } = await notes();
      const results = await Promise.allSettled([
        sql.transaction(async () => { await add("first"); await sleep(5); }),
        sql.transaction(async () => { await add("second"); await sleep(5); throw new Error("second failed"); }),
        sql.transaction(async () => { await add("third"); }),
      ]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
      expect(await bodies()).toEqual(["first", "third"]);
    });

    test("work a transaction started without awaiting, still running once it ended, waits like any statement from outside", async () => {
      const { sql, add, bodies } = await notes();
      let late: Promise<unknown> | undefined;
      await sql.transaction(async () => {
        await add("inside");
        late = sleep(5).then(() => add("late"));
      });
      const next = sql.transaction(async () => {
        await add("next");
        await sleep(30);
        throw new Error("next failed");
      });
      await expect(next).rejects.toThrow("next failed");
      await late;
      expect(await bodies()).toEqual(["inside", "late"]);
    });
  });

  describe("the writer lock", () => {
    test("only one instance per schema takes it; another waits up to its timeout, and gets it once the holder ends", async () => {
      const schema = await newSchema();
      const first = connect({ schema });
      await first.lockWriter();
      expect(await holdsWriterLock(await pid(first))).toBe(true);

      const started = Date.now();
      const second = connect({ schema, timeouts: { writerLockMs: 300 } });
      await expect(second.lockWriter()).rejects.toThrow(PgWriterLockError);
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      await expect(second.lockWriter()).rejects.toThrow(`Another Code Review Workspace holds the writer lock on Postgres schema "${schema}" (waited 0.3 s)`);

      // Another schema's lock is its own.
      await connect({ schema: await newSchema(), timeouts: { writerLockMs: 0 } }).lockWriter();

      const third = connect({ schema, timeouts: { writerLockMs: 5_000 } });
      const waiting = third.lockWriter();
      await sleep(200);
      await first.end();
      await waiting;
      expect(await holdsWriterLock(await pid(third))).toBe(true);
    });

    test("ending lets the lock go, and later calls are refused", async () => {
      const schema = await newSchema();
      const first = connect({ schema });
      await first.lockWriter();
      await first.end();
      await first.end();
      await expect(first.get(`SELECT 1`)).rejects.toThrow("The Postgres connection was closed");
      await connect({ schema, timeouts: { writerLockMs: 0 } }).lockWriter();
    });

    test("ending while waiting for the lock stops the wait", async () => {
      const schema = await newSchema();
      await connect({ schema }).lockWriter();
      const waiter = connect({ schema, timeouts: { writerLockMs: 10_000 } });
      const waiting = waiter.lockWriter();
      await sleep(150);
      const started = Date.now();
      await waiter.end();
      await expect(waiting).rejects.toThrow("The Postgres connection was closed");
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  describe("losing the connection", () => {
    test("a connection killed between calls is made again by the next call, in the schema and holding the writer lock", async () => {
      const schema = await newSchema();
      const lost = vi.fn();
      const sql = connect({ schema, onConnectionLost: lost });
      await sql.lockWriter();
      const before = await pid(sql);
      await terminate(before);
      await vi.waitFor(() => { expect(lost).toHaveBeenCalledTimes(1); });
      expect(lost.mock.calls[0]![0]).toMatchObject({ code: "57P01" });

      const after = await pid(sql);
      expect(after).not.toBe(before);
      expect(await sql.get(`SELECT current_schema() AS schema`)).toEqual({ schema });
      expect(await holdsWriterLock(after)).toBe(true);
      await expect(connect({ schema, timeouts: { writerLockMs: 0 } }).lockWriter()).rejects.toThrow(PgWriterLockError);
    });

    test("a call the connection is lost under fails, and the next one, right after, connects again", async () => {
      const lost = vi.fn();
      const { sql, add, bodies } = await notes({ onConnectionLost: lost });
      const before = await pid(sql);
      const sleeping = sql.get(`SELECT pg_sleep(5)`);
      await sleep(100);
      await terminate(before);
      // Postgres's FATAL error reaches the call before pg sees the connection close.
      await expect(sleeping).rejects.toMatchObject({ code: "57P01" });
      expect(lost).toHaveBeenCalledTimes(1);
      await add("after");
      expect(await bodies()).toEqual(["after"]);
      expect(await pid(sql)).not.toBe(before);
    });

    test("a transaction the connection is lost in fails without committing anything, and the next call connects again", async () => {
      const { sql, add, bodies } = await notes();
      const failing = sql.transaction(async () => {
        await add("lost");
        await terminate(await pid(sql));
        await sleep(50);
        await add("after the kill");
      });
      await expect(failing).rejects.toThrow();
      expect(await bodies()).toEqual([]);
    });

    test("a reconnect waits for the writer lock, and fails the call when another instance took it meanwhile", async () => {
      const schema = await newSchema();
      const first = connect({ schema, timeouts: { writerLockMs: 300 } });
      await first.lockWriter();
      await terminate(await pid(first));
      const second = connect({ schema, timeouts: { writerLockMs: 2_000 } });
      await second.lockWriter();
      await expect(first.get(`SELECT 1`)).rejects.toThrow(PgWriterLockError);
      await second.end();
      expect(await holdsWriterLock(await pid(first))).toBe(true);
    });
  });

  describe("timeouts", () => {
    test("Postgres cancels a statement past statement_timeout, and the connection carries on", async () => {
      const { sql } = await notes({ timeouts: { statementMs: 200 } });
      const before = await pid(sql);
      await expect(sql.get(`SELECT pg_sleep(2)`)).rejects.toMatchObject({ code: "57014" });
      expect(await pid(sql)).toBe(before);
    });

    test("past query_timeout the call fails and the connection is dropped, so the next call has a new one", async () => {
      const { sql } = await notes({ timeouts: { statementMs: 10_000, queryMs: 200 } });
      const before = await pid(sql);
      await expect(sql.get(`SELECT pg_sleep(2)`)).rejects.toThrow("Query read timeout");
      expect(await pid(sql)).not.toBe(before);
    });

    test("Postgres ends a session idle in a transaction past idle_in_transaction_session_timeout, and nothing commits", async () => {
      const lost = vi.fn();
      const { sql, add, bodies } = await notes({ timeouts: { idleInTransactionMs: 200 }, onConnectionLost: lost });
      const before = await pid(sql);
      await expect(sql.transaction(async () => {
        await add("idle");
        await sleep(600);
        await add("too late");
      })).rejects.toThrow();
      expect(lost.mock.calls[0]![0]).toMatchObject({ code: "25P03" });
      expect(await bodies()).toEqual([]);
      expect(await pid(sql)).not.toBe(before);
    });
  });
});
