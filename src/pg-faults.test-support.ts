// For tests, not the plugin: the plugin on Postgres storage, reached through a TCP proxy the test controls, so Postgres
// can go away, hang, or come back while the plugin serves; and the crashes BB 0.46.1 would exit on.
import { connect, createServer, type Server, type Socket } from "node:net";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { expect, vi } from "vitest";
import { pgSql, type PgSql } from "./db/pg";
import { migratePg } from "./db/pg-migrations";
import { testPgOptions, testPgUrl, testSchemaName } from "./db/pg-test.test-support";
import { STORAGE_OWNER_KEY } from "./storage";

export const PLUGIN = "code-review-workspace";

/**
 * A proxy to the test's Postgres. forward: passes bytes. down: refuses new connections and cuts the open ones, as a
 * stopped server does. hang: accepts connections and holds every byte, as a paused server or a dropped network does.
 */
export interface FaultProxy {
  port: number;
  /** Bytes Postgres has sent through the proxy so far. */
  readonly bytesFromPostgres: number;
  mode(next: "forward" | "down" | "hang"): Promise<void>;
  close(): Promise<void>;
}

export async function faultProxy(): Promise<FaultProxy> {
  const target = new URL(testPgUrl!);
  const pairs = new Set<{ client: Socket; upstream: Socket | null }>();
  let current: "forward" | "down" | "hang" = "forward";
  let server: Server | null = null;
  let port = 0;
  let bytesFromPostgres = 0;
  const handle = (client: Socket) => {
    const pair: { client: Socket; upstream: Socket | null } = { client, upstream: null };
    pairs.add(pair);
    client.on("error", () => {});
    client.on("close", () => { pair.upstream?.destroy(); pairs.delete(pair); });
    if (current === "hang") { client.pause(); return; }
    const upstream = connect(Number(target.port || 5432), target.hostname);
    pair.upstream = upstream;
    upstream.on("error", () => { client.destroy(); });
    upstream.on("close", () => { client.destroy(); });
    upstream.on("data", (chunk: Buffer) => { bytesFromPostgres += chunk.length; });
    client.pipe(upstream);
    upstream.pipe(client);
  };
  const listen = () => new Promise<void>((resolve) => {
    server = createServer(handle);
    server.listen(port, "127.0.0.1", () => { port = (server!.address() as { port: number }).port; resolve(); });
  });
  const stopListening = () => new Promise<void>((resolve) => { if (!server) return resolve(); server.close(() => resolve()); server = null; });
  await listen();
  return {
    get port() { return port; },
    get bytesFromPostgres() { return bytesFromPostgres; },
    async mode(next) {
      if (next === current) return;
      if (next === "down") {
        await new Promise<void>((resolve) => { const s = server; server = null; if (!s) return resolve(); s.close(() => resolve()); for (const { client, upstream } of pairs) { client.destroy(); upstream?.destroy(); } });
      } else if (next === "hang") {
        // Existing connections stop passing bytes either way; new ones are accepted and held.
        for (const { client, upstream } of pairs) { client.unpipe(); upstream?.unpipe(); client.pause(); upstream?.pause(); }
        if (!server) await listen();
      } else {
        // Held connections are cut, as a network coming back finds the old sessions gone; new ones pass.
        for (const { client, upstream } of pairs) { client.destroy(); upstream?.destroy(); }
        if (!server) await listen();
      }
      current = next;
    },
    async close() {
      for (const { client, upstream } of pairs) { client.destroy(); upstream?.destroy(); }
      await stopListening();
    },
  };
}

/** The plugin's settings for Postgres storage in a new schema, through `port` when given. */
export function postgresSettings(port?: number) {
  const schema = testSchemaName();
  const options = testPgOptions(schema);
  const url = new URL(options.url);
  if (port) { url.hostname = "127.0.0.1"; url.port = String(port); }
  return {
    schema,
    settings: { storageBackend: "postgres", postgresUrl: url.href, postgresPassword: options.password as string, postgresSchema: schema, postgresSsl: "require" },
  };
}

/** A host whose storage:owner says its reviews are in Postgres, in a schema migrate made, as migrate leaves it. */
export async function host(settings: Record<string, string>, sdk?: object) {
  const schema = settings.postgresSchema!;
  const migrating = pgSql(testPgOptions(schema));
  try { await migratePg(migrating, schema); } finally { await migrating.end(); }
  const { bb, harness } = createFakePluginHost({ pluginId: PLUGIN, settings, ...(sdk ? { sdk } : {}) });
  await bb.storage.kv.set(STORAGE_OWNER_KEY, "postgres");
  return { bb, harness } as { bb: BbPluginApi; harness: FakePluginHarness };
}

export async function opened(harness: FakePluginHarness) {
  await vi.waitFor(() => { expect(harness.inspection.registrations.agentTools.length).toBeGreaterThan(10); }, { timeout: 15_000, interval: 50 });
}

/** A connection of the test's own, as an administrator would have, to `schema`. */
export function adminConnection(schema = "public"): PgSql {
  return pgSql(testPgOptions(schema));
}

/** Every unhandled rejection and uncaught exception while `fn` runs: either would end BB 0.46.1 outside a service. */
export async function watchCrashes<T>(fn: (seen: unknown[]) => Promise<T>): Promise<{ value: T; crashes: unknown[] }> {
  const crashes: unknown[] = [];
  const onRejection = (reason: unknown) => { crashes.push(reason); };
  const onException = (error: unknown) => { crashes.push(error); };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  try {
    const value = await fn(crashes);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { value, crashes };
  } finally {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  }
}

/** How long `promise` takes to settle, and how. */
export async function timed<T>(promise: Promise<T>): Promise<{ ms: number; ok: boolean; value?: T; error?: string }> {
  const started = performance.now();
  try {
    const value = await promise;
    return { ms: Math.round(performance.now() - started), ok: true, value };
  } catch (error) {
    return { ms: Math.round(performance.now() - started), ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
