// The plugin on Postgres storage, opened at activation by its storage service: against the Postgres CRW_TEST_PG_URL
// names, each test in a schema of its own.
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("./db/pg", async (original) => {
  const actual = await original<typeof import("./db/pg")>();
  // A held writer lock fails a try in under a second rather than 30, and each schema's plugin connections are named for it.
  return { ...actual, pgSql: (options: import("./db/pg").PgOptions) => actual.pgSql({ applicationName: `crw-p10 ${options.schema}`, ...options, timeouts: { writerLockMs: 400, ...options.timeouts } }) };
});

import { connect, createServer, type Server, type Socket } from "node:net";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makePluginAgentConfigurationContext, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { pgSql, type PgSql } from "./db/pg";
import { migratePg } from "./db/pg-migrations";
import { testPgOptions, testPgUrl, testSchemaName } from "./db/pg-test.test-support";
import { STORAGE_OWNER_KEY } from "./storage";
import { storeOn } from "./store";

const PLUGIN = "code-review-workspace";

const ended: PgSql[] = [];
const schemas: string[] = [];
const closing: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closing.splice(0)) await close();
  await Promise.all(ended.splice(0).map((connection) => connection.end()));
  const admin = pgSql(testPgOptions("public"));
  try {
    for (const schema of schemas.splice(0)) await admin.run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
});

/** A connection of the test's own to `schema`, ended after the test. */
function connection(schema: string): PgSql {
  const made = pgSql(testPgOptions(schema));
  ended.push(made);
  return made;
}

/** The plugin's settings for Postgres storage in a new schema, and that schema. */
function postgresSettings(overrides: { port?: number; password?: string } = {}) {
  const schema = testSchemaName();
  schemas.push(schema);
  const options = testPgOptions(schema);
  const url = new URL(options.url);
  if (overrides.port) { url.hostname = "127.0.0.1"; url.port = String(overrides.port); }
  return {
    schema,
    settings: { storageBackend: "postgres", postgresUrl: url.href, postgresPassword: overrides.password ?? options.password as string, postgresSchema: schema, postgresSsl: "require" },
  };
}

/** A host whose storage:owner says its reviews are in Postgres, as migrate leaves it, in a schema migrate made, unless `unmigrated`. */
async function host(settings: Record<string, string>, sdk?: object, unmigrated = false) {
  if (!unmigrated) await migratePg(connection(settings.postgresSchema!), settings.postgresSchema!);
  const { bb, harness } = createFakePluginHost({ pluginId: PLUGIN, settings, ...(sdk ? { sdk } : {}) });
  await bb.storage.kv.set(STORAGE_OWNER_KEY, "postgres");
  return { bb, harness };
}

function registered(harness: FakePluginHarness) {
  const r = harness.inspection.registrations;
  return {
    tools: r.agentTools.length,
    rpc: r.rpcMethods.length,
    events: Object.values(r.threadEventHandlers).reduce((sum, count) => sum + count, 0),
  };
}

const yourThread = makePluginAgentConfigurationContext({ thread: { id: "yours", title: "Mine" } });

/** The plugin's connections to `schema`, by the name the mock gives them. */
async function pluginConnections(admin: PgSql, schema: string) {
  return (await admin.get<{ n: number }>("SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = ?", [`crw-p10 ${schema}`]))!.n;
}

const sqliteHasReviews = (bb: BbPluginApi) => !!bb.storage.database().prepare("SELECT 1 FROM sqlite_master WHERE name = 'reviews'").get();

/** Wait for the storage service to open the store: the plugin's tools are registered once it has. */
async function opened(harness: FakePluginHarness) {
  await vi.waitFor(() => { expect(registered(harness).tools).toBeGreaterThan(10); }, { timeout: 15_000, interval: 50 });
}

describe.skipIf(!testPgUrl)("the plugin on Postgres storage", () => {
  test("opened at activation, the store serves the tools, RPC handlers and events, writes to Postgres, never to SQLite, and lets the writer lock go on dispose", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    await plugin(bb);
    expect(registered(harness)).toEqual({ tools: 0, rpc: 0, events: 0 });
    expect(harness.inspection.registrations.agentConfigurationProvider!(yourThread)).toEqual({ tools: [], skills: [] });
    harness.behavior.runService("storage");
    await opened(harness);
    expect(registered(harness).rpc).toBeGreaterThan(10);
    expect(registered(harness).events).toBeGreaterThan(0);
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
    expect((await harness.behavior.runCli(["storage", "status"])).stdout).toBe("storageBackend: postgres\nstorage:owner: postgres\nstate: serving");
    // configure answers from the open store's view now, at once as ever.
    const configured = harness.inspection.registrations.agentConfigurationProvider!(yourThread);
    expect(configured).not.toBeInstanceOf(Promise);
    expect(configured).toEqual({ tools: [], skills: ["code-review-workspace"] });

    const { preferences, revision } = await harness.behavior.callRpc("getPreferences", null) as { preferences: object; revision: number };
    await harness.behavior.callRpc("savePreferences", { preferences: { ...preferences, assistantInstructions: "Be brief." }, revision });
    const admin = connection(schema);
    expect(JSON.parse((await admin.get<{ value: string }>("SELECT value FROM review_preferences"))!.value)).toMatchObject({ assistantInstructions: "Be brief." });
    expect(await harness.behavior.runCli(["list", "--json"])).toMatchObject({ exitCode: 0 });
    expect(sqliteHasReviews(bb)).toBe(false);
    expect(await pluginConnections(admin, schema)).toBe(1);

    await harness.lifecycle.dispose();
    await vi.waitFor(async () => { expect(await pluginConnections(admin, schema)).toBe(0); });
    const next = connection(schema);
    await next.lockWriter();
  });

  // bug bash E2: a changed postgresSchema or postgresUrl, by a typo, a reinstall or a new database, was given new empty
  // tables and served as an empty review list, while the reviews sat in the schema used until then.
  test("a schema migrate didn't make isn't served or made: needsConfiguration says to check postgresUrl and postgresSchema", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings, undefined, true);
    await plugin(bb);
    harness.behavior.runService("storage");
    await vi.waitFor(() => {
      expect(harness.inspection.needsConfigurationMessages).toEqual([
        `Code Review Workspace can't open its Postgres storage: storage:owner says the reviews are in Postgres, but schema "${schema}" holds none: check postgresUrl and postgresSchema, then reload. It keeps trying, and serves once it gets through; this status stays until the plugin reloads (bb plugin reload code-review-workspace).`,
      ]);
    }, { timeout: 5_000, interval: 50 });
    expect(registered(harness)).toEqual({ tools: 0, rpc: 0, events: 0 });
    expect(await connection("public").get("SELECT 1 FROM pg_namespace WHERE nspname=?", [schema])).toBeUndefined();
    await harness.lifecycle.dispose();
  });

  // Review round 1, NIT 4: docs/operations.md's way to start over when the schema holding the reviews is lost.
  test("a schema lost and made again with an empty crw_migrations by hand, as the operations guide says, is served with no reviews", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings, undefined, true);
    const admin = connection("public");
    await admin.run(`CREATE SCHEMA ${schema}`);
    await admin.run(`CREATE TABLE ${schema}.crw_migrations (id INTEGER PRIMARY KEY, statement_hash TEXT NOT NULL, applied_at BIGINT NOT NULL)`);
    await plugin(bb);
    harness.behavior.runService("storage");
    await opened(harness);
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
    expect(await harness.behavior.runCli(["list", "--json"])).toMatchObject({ exitCode: 0 });
    expect((await connection(schema).get<{ n: number }>("SELECT count(*) AS n FROM reviews"))!.n).toBe(0);
    await harness.lifecycle.dispose();
  });

  test("with the writer lock held elsewhere, only the CLI serves and needsConfiguration says why, until the holder lets it go", async () => {
    const { schema, settings } = postgresSettings();
    const holder = connection(schema);
    await holder.lockWriter();
    const { bb, harness } = await host(settings);
    await plugin(bb);
    harness.behavior.runService("storage");
    await vi.waitFor(() => {
      expect(harness.inspection.needsConfigurationMessages).toEqual([
        `Code Review Workspace can't open its Postgres storage: Another Code Review Workspace holds the writer lock on Postgres schema "${schema}" (waited 0.4 s). Stop the other BB using this schema, or give this one a schema of its own (postgresSchema). It keeps trying, and serves once it gets through; this status stays until the plugin reloads (bb plugin reload code-review-workspace).`,
      ]);
    }, { timeout: 5_000, interval: 50 });
    expect(registered(harness)).toEqual({ tools: 0, rpc: 0, events: 0 });
    expect(await harness.behavior.runCli(["list"])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("holds the writer lock") });
    await holder.end();
    await opened(harness);
    expect((await harness.behavior.runCli(["storage", "status"])).stdout).toBe("storageBackend: postgres\nstorage:owner: postgres\nstate: serving");
    expect(harness.inspection.logEntries).toContainEqual({ level: "info", message: "Code Review Workspace's Postgres storage is open. Its needs-configuration status stays until the plugin reloads (bb plugin reload code-review-workspace)." });
    await harness.lifecycle.dispose();
  });

  test("out of reach at activation, as after a power cut BB came back from first, it serves once Postgres comes up, without needsConfiguration", async () => {
    // A port nothing listens on, until a proxy to the test's Postgres opens on it.
    const free = createServer();
    await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
    const port = (free.address() as { port: number }).port;
    await new Promise<void>((resolve) => free.close(() => resolve()));
    const { settings } = postgresSettings({ port });
    const { bb, harness } = await host(settings);
    await plugin(bb);
    harness.behavior.runService("storage");
    await vi.waitFor(() => {
      expect(harness.inspection.logEntries.map((entry) => entry.message)).toContainEqual(expect.stringMatching(/^Could not open Code Review Workspace's Postgres storage: .*ECONNREFUSED.*\. Trying again in 1 s\.$/));
    }, { timeout: 5_000, interval: 20 });
    expect(registered(harness)).toEqual({ tools: 0, rpc: 0, events: 0 });
    // bug bash F8: bb review answered only pg's bare message, which said nothing of Postgres or of opening it.
    expect(await harness.behavior.runCli(["list"])).toEqual({ exitCode: 1, stdout: "", stderr: expect.stringMatching(/^Code Review Workspace is opening its Postgres storage \(latest try: .*ECONNREFUSED.*\)\. Try again in a moment; bb review storage status says more\.$/) });

    const target = new URL(testPgUrl!);
    const sockets = new Set<Socket>();
    const proxy: Server = createServer((client) => {
      const upstream = connect(Number(target.port || 5432), target.hostname);
      for (const socket of [client, upstream]) { sockets.add(socket); socket.on("error", () => { client.destroy(); upstream.destroy(); }); }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve) => proxy.listen(port, "127.0.0.1", resolve));
    closing.push(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); proxy.close(() => resolve()); }));
    await opened(harness);
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
    await harness.lifecycle.dispose();
  });

  // bug bash F9: Node's message, which suggests running Node with --use-system-ca, was passed on as it was.
  test("verify-full against a certificate no CA it trusts signed names postgresCaPem in needsConfiguration", async () => {
    const { settings } = postgresSettings();
    const { bb, harness } = await host({ ...settings, postgresSsl: "verify-full" });
    await plugin(bb);
    harness.behavior.runService("storage");
    await vi.waitFor(() => expect(harness.inspection.needsConfigurationMessages).toHaveLength(1), { timeout: 5_000, interval: 20 });
    const [message] = harness.inspection.needsConfigurationMessages;
    expect(message).toMatch(/^Code Review Workspace can't open its Postgres storage: verify-full: the server's certificate isn't signed by the CA in postgresCaPem, or by one of Node's CAs when it's empty \([A-Z_]+\)\./);
    expect(message).not.toContain("--use-system-ca");
    await harness.lifecycle.dispose();
  });

  test("a wrong password is told to needsConfiguration at once, without the URL or password", async () => {
    const password = "not-the-password-p10";
    const { settings } = postgresSettings({ password });
    const { bb, harness } = await host(settings);
    await plugin(bb);
    harness.behavior.runService("storage");
    await vi.waitFor(() => { expect(harness.inspection.needsConfigurationMessages).toHaveLength(1); }, { timeout: 5_000, interval: 20 });
    const [message] = harness.inspection.needsConfigurationMessages;
    expect(message).toContain("Postgres answered: password authentication failed for user");
    expect(message).toContain("(SQLSTATE 28P01)");
    for (const said of [message, ...harness.inspection.logEntries.map((entry) => entry.message)]) {
      expect(said).not.toContain(password);
      expect(said).not.toContain(settings.postgresUrl);
    }
    expect(registered(harness)).toEqual({ tools: 0, rpc: 0, events: 0 });
    await harness.lifecycle.dispose();
  });

  test("a reload's factory leaves Postgres to the instance still serving, and the new one, opened once that one has gone, finds what it wrote", async () => {
    const { schema, settings } = postgresSettings();
    const { bb, harness } = await host(settings);
    await plugin(bb);
    harness.behavior.runService("storage");
    await opened(harness);
    const { preferences, revision } = await harness.behavior.callRpc("getPreferences", null) as { preferences: object; revision: number };
    await harness.behavior.callRpc("savePreferences", { preferences: { ...preferences, assistantInstructions: "Written before the reload." }, revision });
    const admin = connection(schema);
    let duringFactory: { connections: number; oldServes: unknown } | undefined;
    const next = await harness.lifecycle.reload(async (replacement) => {
      await plugin(replacement);
      // BB disposes the old instance only once this factory has returned.
      duringFactory = { connections: await pluginConnections(admin, schema), oldServes: await harness.behavior.callRpc("getPreferences", null) };
    });
    expect(duringFactory).toEqual({ connections: 1, oldServes: expect.objectContaining({ preferences: expect.objectContaining({ assistantInstructions: "Written before the reload." }) }) });
    expect(registered(next.harness)).toEqual({ tools: 0, rpc: 0, events: 0 });
    await vi.waitFor(async () => { expect(await pluginConnections(admin, schema)).toBe(0); });
    next.harness.behavior.runService("storage");
    await opened(next.harness);
    expect(next.harness.inspection.needsConfigurationMessages).toEqual([]);
    expect(await next.harness.behavior.callRpc("getPreferences", null)).toMatchObject({ preferences: { assistantInstructions: "Written before the reload." } });
    await next.harness.lifecycle.dispose();
  });

  test("a store call that work started before a dispose makes after it is refused, caught and logged, never left unhandled", async () => {
    const { schema, settings } = postgresSettings();
    const seeding = connection(schema);
    await migratePg(seeding, schema);
    const seed = storeOn(seeding);
    await seed.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, projectId: "p1" });
    await seed.setLifecycle("pr-1", { verifyingSince: 1, verifyingMessageId: "m1" });
    await seed.setAssistantThread("pr-1", "assistant-1");
    // The startup sweep of reviews waiting on their assistants asks for the assistant's queue, and is answered after the dispose.
    let answer: (queue: Array<{ id: string }>) => void = () => {};
    const asked = vi.fn();
    const { bb, harness } = await host(settings, {
      threads: { queuedMessages: { list: () => { asked(); return new Promise((resolve) => { answer = resolve; }); } } },
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await plugin(bb);
      harness.behavior.runService("storage");
      await opened(harness);
      await vi.waitFor(() => { expect(asked).toHaveBeenCalled(); }, { timeout: 5_000, interval: 20 });
      await harness.lifecycle.dispose();
      answer([]);
      await vi.waitFor(() => {
        expect(harness.inspection.logEntries).toContainEqual({ level: "warn", message: "Could not settle reviews waiting on their assistants: StoreDisposedError: The store was disposed" });
      }, { timeout: 5_000, interval: 20 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
