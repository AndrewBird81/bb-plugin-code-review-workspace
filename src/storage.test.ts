import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

import { createServer, type Server, type Socket } from "node:net";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makePluginAgentConfigurationContext, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import pg from "pg";
import plugin from "../server";
import { PgWriterLockError } from "./db/pg";
import { chooseStorage, describe as describeProblem, openPostgres, STORAGE_OWNER_KEY, unreachable, type StorageChoice } from "./storage";
import { startPlugin } from "./plugin-store.test-support";

const PLUGIN = "code-review-workspace";
const PASSWORD = "s3cret-pass-p10";

/** A fake host with these stored settings, and storage:owner set to `owner` unless it's undefined. */
async function host(settings: Record<string, string> = {}, owner?: unknown) {
  const { bb, harness } = createFakePluginHost({ pluginId: PLUGIN, settings });
  if (owner !== undefined) await bb.storage.kv.set(STORAGE_OWNER_KEY, owner);
  return { bb, harness };
}

/** What the plugin registered, by kind. */
function registered(harness: FakePluginHarness) {
  const r = harness.inspection.registrations;
  return {
    cli: r.cli?.name ?? null,
    tools: r.agentTools.length,
    rpc: r.rpcMethods.length,
    events: Object.values(r.threadEventHandlers).reduce((sum, count) => sum + count, 0),
    services: r.services.map((service) => service.name),
    schedules: r.schedules.map((schedule) => schedule.name),
    http: r.httpRoutes.length,
  };
}

const ONLY_CLI = { cli: "review", tools: 0, rpc: 0, events: 0, services: [], schedules: [], http: 0 };

/** This plugin's own thread, a thread of yours, and configure with no thread. */
const contexts = [
  makePluginAgentConfigurationContext({ thread: { id: "worker", title: "Review agent: pr-1" }, origin: { kind: null, pluginId: PLUGIN } }),
  makePluginAgentConfigurationContext({ thread: { id: "yours", title: "Mine" } }),
];

/** configure answers at once, with nothing for any thread, as before the store is open. */
function expectConfiguresNothing(harness: FakePluginHarness) {
  const provider = harness.inspection.registrations.agentConfigurationProvider!;
  for (const context of contexts) {
    const answer = provider(context);
    expect(answer).not.toBeInstanceOf(Promise);
    expect(answer).toEqual({ tools: [], skills: [] });
  }
}

/** Whether the Store made its tables in the plugin's SQLite database. */
const sqliteHasReviews = (bb: BbPluginApi) => !!bb.storage.database().prepare("SELECT 1 FROM sqlite_master WHERE name = 'reviews'").get();

/** A local TCP server that counts connections and closes each one, so nothing Postgres can sign in. */
async function listener(): Promise<{ server: Server; port: number; connections: () => number }> {
  let count = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { count++; sockets.add(socket); socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.on("close", () => { for (const socket of sockets) socket.destroy(); });
  return { server, port: (server.address() as { port: number }).port, connections: () => count };
}

const closing: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

describe("the storage settings", () => {
  test("are defined with SQLite the default, Postgres's schema and TLS defaults, and its password secret", async () => {
    const { bb, harness } = await host();
    await plugin(bb);
    const descriptors = harness.inspection.registrations.settingsDescriptors;
    expect(Object.keys(descriptors)).toEqual(["storageBackend", "postgresUrl", "postgresPassword", "postgresSchema", "postgresSsl", "postgresCaPem"]);
    expect(descriptors.storageBackend).toMatchObject({ type: "select", options: ["sqlite", "postgres"], default: "sqlite" });
    expect(descriptors.postgresPassword).toMatchObject({ type: "string", secret: true });
    expect(descriptors.postgresSchema).toMatchObject({ default: "code_review_workspace" });
    expect(descriptors.postgresSsl).toMatchObject({ type: "select", options: ["verify-full", "require", "disable"], default: "require" });
    expect(descriptors.postgresCaPem).toMatchObject({ type: "string", experimental_multiline: true });
  });

  test("a change is logged as applying once the plugin reloads, and changes nothing until then", async () => {
    const { bb, harness } = await host();
    await plugin(bb);
    const before = registered(harness);
    await harness.behavior.setSettings({ storageBackend: "postgres" });
    expect(harness.inspection.logEntries).toContainEqual({ level: "info", message: `Storage settings changed: they apply once the plugin reloads (bb plugin reload ${PLUGIN}).` });
    expect(registered(harness)).toEqual(before);
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
  });
});

describe("SQLite, the default", () => {
  test("with no settings and no owner marked, the plugin serves from SQLite in the factory, as before", async () => {
    const { bb, harness } = await host();
    await plugin(bb);
    expect(registered(harness)).toMatchObject({ cli: "review", services: ["plugin-updates", "review-state"], schedules: ["prune-old-diffs"] });
    expect(registered(harness).tools).toBeGreaterThan(10);
    expect(harness.inspection.registrations.rpcMethods).toContain("getPreferences");
    expect(registered(harness).events).toBeGreaterThan(0);
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
    expect(await harness.behavior.callRpc("getPreferences", null)).toMatchObject({ revision: expect.any(Number) });
    expect(await harness.behavior.runCli(["storage", "status"])).toEqual({ exitCode: 0, stderr: "", stdout: "storageBackend: sqlite\nstorage:owner: sqlite\nstate: serving" });
    // The owner stays unmarked: an install that never moved its reviews keeps them where 1.2.0 did.
    expect(await bb.storage.kv.get(STORAGE_OWNER_KEY)).toBeUndefined();
  });

  test("owned by SQLite, it serves from it", async () => {
    const { bb, harness } = await host({ storageBackend: "sqlite" }, "sqlite");
    await plugin(bb);
    expect(registered(harness).tools).toBeGreaterThan(10);
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
  });
});

const postgres = (port: number, extra: Record<string, string> = {}) => ({
  storageBackend: "postgres", postgresUrl: `postgres://crw@127.0.0.1:${port}/crw`, postgresPassword: PASSWORD, ...extra,
});

describe("maintenance: only the CLI, until the settings and the owner agree", () => {
  const cases: Array<{ name: string; settings: Record<string, string>; owner?: unknown; says: string }> = [
    { name: "Postgres chosen, reviews never moved", settings: postgres(5432), says: "Run bb review storage migrate to copy them to Postgres, then bb plugin reload code-review-workspace" },
    { name: "Postgres chosen, reviews in SQLite", settings: postgres(5432), owner: "sqlite", says: "its reviews are in SQLite" },
    { name: "SQLite chosen, reviews in Postgres", settings: { storageBackend: "sqlite" }, owner: "postgres", says: "or run bb review storage export-sqlite --replace-data-db to copy them to SQLite first" },
    { name: "an owner this version doesn't know", settings: {}, owner: "mysql", says: "marked as kept in mysql (storage:owner), which this version doesn't know" },
    { name: "an owner that isn't a name", settings: {}, owner: { backend: "sqlite" }, says: "marked as kept in {\"backend\":\"sqlite\"}" },
    { name: "Postgres without a URL", settings: { storageBackend: "postgres", postgresPassword: PASSWORD }, owner: "postgres", says: "can't use Postgres: postgresUrl is not set" },
    { name: "Postgres without a password", settings: { storageBackend: "postgres", postgresUrl: "postgres://crw@db.example:5432/crw" }, owner: "postgres", says: "postgresPassword is not set" },
    { name: "a URL holding the password", settings: { ...postgres(5432), postgresUrl: `postgres://crw:${PASSWORD}@db.example:5432/crw` }, owner: "postgres", says: "postgresUrl holds a password" },
    { name: "a URL with sslmode", settings: postgres(5432, { postgresUrl: "postgres://crw@db.example:5432/crw?sslmode=disable" }), owner: "postgres", says: "postgresUrl takes no query parameters" },
    { name: "a CA without verify-full", settings: postgres(5432, { postgresCaPem: "-----BEGIN CERTIFICATE-----" }), owner: "postgres", says: "postgresCaPem is only used with postgresSsl=verify-full" },
  ];

  test.each(cases)("$name", async ({ settings, owner, says }) => {
    const { bb, harness } = await host(settings, owner);
    await plugin(bb);
    expect(registered(harness)).toEqual(ONLY_CLI);
    const [message, ...more] = harness.inspection.needsConfigurationMessages;
    expect(more).toEqual([]);
    expect(message).toContain(says);
    expect(message).not.toContain(PASSWORD);
    if (settings.postgresUrl) expect(message).not.toContain(settings.postgresUrl);
    expect(harness.inspection.logEntries).toContainEqual({ level: "warn", message });
    expectConfiguresNothing(harness);
    expect(await harness.behavior.resolveAgentConfiguration(contexts[0])).toEqual({ tools: [], skills: [], instructions: null });
    for (const argv of [["list"], ["pr-1"], ["comment", "list", "pr-1"], ["--help"]]) {
      expect(await harness.behavior.runCli(argv)).toEqual({ exitCode: 1, stdout: "", stderr: message });
    }
    const status = await harness.behavior.runCli(["storage", "status"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("state: maintenance; only bb review storage answers");
    expect(status.stdout).toContain(`problem: ${message}`);
    // It never falls back to SQLite.
    expect(sqliteHasReviews(bb)).toBe(false);
    await harness.lifecycle.dispose();
  });
});

describe("Postgres, before it's open", () => {
  test("the factory connects to nothing, and registers the CLI, configure, and the services that open the store and wait for it", async () => {
    const pgServer = await listener();
    closing.push(() => new Promise((resolve) => { pgServer.server.close(() => resolve()); }));
    const { bb, harness } = await host(postgres(pgServer.port), "postgres");
    await plugin(bb);
    expect(pgServer.connections()).toBe(0);
    expect(registered(harness)).toEqual({ ...ONLY_CLI, services: ["plugin-updates", "review-state", "storage"], schedules: ["prune-old-diffs"] });
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
    expectConfiguresNothing(harness);
    expect(await harness.behavior.runCli(["list"])).toEqual({ exitCode: 1, stdout: "", stderr: "Code Review Workspace is opening its Postgres storage. Try again in a moment; bb review storage status says more." });
    expect((await harness.behavior.runCli(["storage", "status"])).stdout).toBe("storageBackend: postgres\nstorage:owner: postgres\nstate: opening Postgres; only bb review storage answers until it's open");
    // The pruning a day brings waits for the store too.
    await harness.behavior.runSchedule("prune-old-diffs");
    expect(sqliteHasReviews(bb)).toBe(false);
    await harness.lifecycle.dispose();
  });

  test("out of reach at activation, it tries again without telling needsConfiguration yet, serving only the CLI, and its services stop at once", async () => {
    const pgServer = await listener();
    closing.push(() => new Promise((resolve) => { pgServer.server.close(() => resolve()); }));
    const { bb, harness } = await host(postgres(pgServer.port), "postgres");
    await plugin(bb);
    const storage = harness.behavior.runService("storage");
    const waiting = [harness.behavior.runService("plugin-updates"), harness.behavior.runService("review-state")];
    // The server closing the connection reads as a reset or as an end, depending on when it lands.
    const problem = await vi.waitFor(() => {
      const [entry, ...more] = harness.inspection.logEntries;
      expect(more).toEqual([]);
      expect(entry.level).toBe("warn");
      return entry.message.match(/^Could not open Code Review Workspace's Postgres storage: (read ECONNRESET|Connection terminated unexpectedly)\. Trying again in 1 s\.$/)![1];
    });
    expect(pgServer.connections()).toBe(1);
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
    expect(registered(harness)).toEqual({ ...ONLY_CLI, services: ["plugin-updates", "review-state", "storage"], schedules: ["prune-old-diffs"] });
    expectConfiguresNothing(harness);
    expect((await harness.behavior.runCli(["storage", "status"])).stdout).toContain(`problem: ${problem}`);
    expect(await harness.behavior.runCli(["list"])).toEqual({ exitCode: 1, stdout: "", stderr: `Code Review Workspace is opening its Postgres storage (latest try: ${problem}). Try again in a moment; bb review storage status says more.` });
    const stopped = Date.now();
    for (const service of [storage, ...waiting]) service.controller.abort();
    await Promise.all([storage.done, ...waiting.map((service) => service.done)]);
    expect(Date.now() - stopped).toBeLessThan(1_000);
    expect(sqliteHasReviews(bb)).toBe(false);
    await harness.lifecycle.dispose();
  });
});

describe("openPostgres", () => {
  const TIMING = { firstRetryMs: 5, maxRetryMs: 20, unreachableGraceMs: 150 };
  const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

  async function postgresChoice() {
    const { bb, harness } = await host(postgres(5432), "postgres");
    const storage = await chooseStorage(bb) as Extract<StorageChoice, { kind: "postgres" }>;
    expect(storage.kind).toBe("postgres");
    closing.push(() => storage.pg.end());
    return { bb, harness, storage };
  }

  test("out of reach, it's logged each time and told to needsConfiguration only past the grace, once; then it opens", async () => {
    const { bb, harness, storage } = await postgresChoice();
    const started = Date.now();
    let tries = 0;
    const opened = await openPostgres(bb, storage, new AbortController().signal, async () => {
      tries++;
      if (Date.now() - started < 300) throw refused();
      return "open";
    }, TIMING);
    expect(opened).toBe("open");
    expect(storage.status).toMatchObject({ state: "serving", problem: null });
    const warned = harness.inspection.logEntries.filter((entry) => entry.level === "warn").map((entry) => entry.message);
    expect(warned).toHaveLength(tries - 1);
    expect(warned.slice(0, 4)).toEqual([0.005, 0.01, 0.02, 0.02].map((s) => `Could not open Code Review Workspace's Postgres storage: connect ECONNREFUSED 127.0.0.1:5432. Trying again in ${s} s.`));
    expect(harness.inspection.needsConfigurationMessages).toEqual([
      "Code Review Workspace can't open its Postgres storage: connect ECONNREFUSED 127.0.0.1:5432. It keeps trying, and serves once it gets through; this status stays until the plugin reloads (bb plugin reload code-review-workspace).",
    ]);
    expect(harness.inspection.logEntries.at(-1)).toEqual({ level: "info", message: "Code Review Workspace's Postgres storage is open. Its needs-configuration status stays until the plugin reloads (bb plugin reload code-review-workspace)." });
  });

  test("a failure that trying again can't fix alone is told at once, each new one again, without the URL or password", async () => {
    const { bb, harness, storage } = await postgresChoice();
    const url = storage.settings.postgresUrl!;
    const failures: unknown[] = [
      Object.assign(new pg.DatabaseError(`password authentication failed for user "crw" at ${url} with ${PASSWORD}`, 0, "error"), { code: "28P01" }),
      Object.assign(new pg.DatabaseError(`password authentication failed for user "crw" at ${url} with ${PASSWORD}`, 0, "error"), { code: "28P01" }),
      new PgWriterLockError("code_review_workspace", 30_000),
    ];
    const opened = await openPostgres(bb, storage, new AbortController().signal, async () => {
      const failure = failures.shift();
      if (failure) throw failure;
      return "open";
    }, TIMING);
    expect(opened).toBe("open");
    expect(harness.inspection.needsConfigurationMessages).toEqual([
      "Code Review Workspace can't open its Postgres storage: Postgres answered: password authentication failed for user \"crw\" at [redacted] with [redacted] (SQLSTATE 28P01). It keeps trying, and serves once it gets through; this status stays until the plugin reloads (bb plugin reload code-review-workspace).",
      "Code Review Workspace can't open its Postgres storage: Another Code Review Workspace holds the writer lock on Postgres schema \"code_review_workspace\" (waited 30 s). Stop the other BB using this schema, or give this one a schema of its own (postgresSchema). It keeps trying, and serves once it gets through; this status stays until the plugin reloads (bb plugin reload code-review-workspace).",
    ]);
    for (const { message } of harness.inspection.logEntries) {
      expect(message).not.toContain(PASSWORD);
      expect(message).not.toContain(url);
    }
  });

  test("aborted, it gives up at once, while a try still runs, and what that try does later goes unheard", async () => {
    const { bb, harness, storage } = await postgresChoice();
    const controller = new AbortController();
    let fail: (error: Error) => void = () => {};
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const opening = openPostgres(bb, storage, controller.signal, () => new Promise<string>((_, reject) => { fail = reject; }), TIMING);
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      expect(await opening).toBeNull();
      fail(refused());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(harness.inspection.logEntries).toEqual([]);
      expect(storage.status.state).toBe("opening");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  test("aborted while it waits to try again, it gives up at once", async () => {
    const { bb, storage } = await postgresChoice();
    const controller = new AbortController();
    const opening = openPostgres(bb, storage, controller.signal, async () => { throw refused(); }, { ...TIMING, firstRetryMs: 60_000 });
    await vi.waitFor(() => { expect(storage.status.problem).toContain("ECONNREFUSED"); });
    controller.abort();
    expect(await opening).toBeNull();
  });
});

test("only a failure to reach Postgres, or a server starting or stopping, counts as out of reach", () => {
  const coded = (code: string) => Object.assign(new Error(code), { code });
  const database = (code: string) => Object.assign(new pg.DatabaseError("from the server", 0, "error"), { code });
  for (const error of [coded("ECONNREFUSED"), coded("ENOTFOUND"), coded("EAI_AGAIN"), coded("ETIMEDOUT"), coded("EHOSTUNREACH"), coded("ECONNRESET"),
    new AggregateError([coded("ECONNREFUSED"), coded("ECONNREFUSED")]), database("57P03"), database("57P01"), database("08006"),
    new Error("timeout expired"), new Error("Connection terminated unexpectedly")]) {
    expect(unreachable(error)).toBe(true);
  }
  for (const error of [database("28P01"), database("3D000"), database("42501"), new PgWriterLockError("s", 30_000), new Error("self-signed certificate"),
    new AggregateError([coded("ECONNREFUSED"), new Error("self-signed certificate")]), "ECONNREFUSED", null]) {
    expect(unreachable(error)).toBe(false);
  }
});

// bug bash F7: a statement timeout or a lock wait at activation, which passes a moment later, was reported as
// needs-configuration at once, and BB kept saying so until a reload.
test("a statement cancelled by its timeout, a lock not granted, a deadlock, and pg's own read timeout count as passing", () => {
  const database = (code: string) => Object.assign(new pg.DatabaseError("from the server", 0, "error"), { code });
  for (const error of [database("57014"), database("55P03"), database("40P01"), new Error("Query read timeout")]) expect(unreachable(error)).toBe(true);
});

// bug bash F9
test("verify-full's refusals of the server's certificate say which setting to check, not Node's options", () => {
  const tls = (code: string, message: string) => Object.assign(new Error(message), { code });
  expect(describeProblem(tls("SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain; if the root CA is installed locally, try running Node.js with --use-system-ca")))
    .toBe("verify-full: the server's certificate isn't signed by the CA in postgresCaPem, or by one of Node's CAs when it's empty (SELF_SIGNED_CERT_IN_CHAIN)");
  expect(describeProblem(tls("ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames: Host: db. is not in the cert's altnames: DNS:localhost")))
    .toBe("verify-full: the server's certificate doesn't name the host in postgresUrl (ERR_TLS_CERT_ALTNAME_INVALID)");
  expect(describeProblem(tls("CERT_HAS_EXPIRED", "certificate has expired"))).toBe("verify-full: the server's certificate isn't valid now (CERT_HAS_EXPIRED)");
});

test("a failed restart of the idle review assistants after a Settings change is logged, not left unhandled", async () => {
  const { bb, harness } = await host();
  const store = await startPlugin(bb);
  vi.spyOn(store, "listAssistantThreads").mockRejectedValue(new Error("The store was disposed"));
  const { preferences, revision } = await harness.behavior.callRpc("getPreferences", null) as { preferences: { assistantInstructions: string }; revision: number };
  await harness.behavior.callRpc("savePreferences", { preferences: { ...preferences, assistantInstructions: `${preferences.assistantInstructions} Be brief.` }, revision });
  await vi.waitFor(() => {
    expect(harness.inspection.logEntries).toContainEqual({ level: "warn", message: "Could not restart the idle review assistants: Error: The store was disposed" });
  });
});
