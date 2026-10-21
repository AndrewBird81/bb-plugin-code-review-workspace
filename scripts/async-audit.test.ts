import { expect, test } from "vitest";
import { Project } from "ts-morph";
import { auditProject, formatAudit, type AuditReport, type StoreUse } from "./async-audit";

const STORE = `
export interface Store {
  get(key: string): string | null;
  set(key: string, value: string): void;
  list(): string[];
}
export function createStore(): Store {
  const rows = new Map<string, string>();
  return {
    get(key) { return rows.get(key) ?? null; },
    set(key, value) { if (this.get(key) !== value) rows.set(key, value); },
    list() { return [...rows.keys()]; },
  };
}
export const tick = () => Promise.resolve();
`;

const HOST = `
export interface Host {
  configure(provider: (context: { id: string }) => { tools: string[] }): void;
  on(event: string, handler: (payload: { id: string }) => void | Promise<void>): void;
  notify(listener: () => void): void;
  register(tool: { name: string; execute(input: unknown): string | Promise<string> }): void;
}
`;

/** Audits a fixture project of store.ts, BB's types in host/sdk.ts, and `files`, by name under /p. */
function audit(files: Record<string, string>): AuditReport {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true, target: 9 /* ES2022 */ } });
  project.createSourceFile("/p/store.ts", STORE);
  project.createSourceFile("/p/host/sdk.ts", HOST);
  for (const [name, text] of Object.entries(files)) project.createSourceFile(`/p/${name}`, text);
  return auditProject(project, {
    root: "/p",
    storeInterfaces: [{ file: "store.ts", name: "Store" }],
    isHostFile: (filePath) => filePath.startsWith("/p/host/"),
    include: (filePath) => !filePath.startsWith("/p/host/"),
  });
}

const labels = (uses: readonly StoreUse[]) => uses.map((u) => u.label);
const fn = (report: AuditReport, name: string) => report.functions.find((f) => f.name === name)!;

test("lists each function that calls the store, sync or async, and the sync helpers that call it for them", () => {
  const report = audit({ "a.ts": `
    import { tick, type Store } from "./store";
    export function read(store: Store) { return store.get("a"); }
    export function viaHelper(store: Store) { return read(store) ?? "none"; }
    export async function load(store: Pick<Store, "list">) { await tick(); return store.list(); }
    export async function viaAsync(store: Store) { return load(store); }
    const deps = (store: Store) => ({ store });
    export function viaDeps(store: Store) { deps(store).store.set("a", "b"); }
    export function untouched() { return 1; }
  ` });
  expect(report.functions.map((f) => [f.name, f.async, labels(f.uses)])).toEqual([
    ["read", false, ["Store.get"]],
    ["viaHelper", false, ["read (a.ts:3)"]],
    ["load", true, ["Store.list"]],
    ["viaDeps", false, ["Store.set"]],
  ]);
  // The implementation's own calls aren't the callers'.
  expect(report.storeCalls).toBe(3);
  expect(report.implementationCalls).toBe(1);
});

test("a stretch from the start to the first await with two store calls is an R2 candidate; one call after it isn't", () => {
  const report = audit({ "a.ts": `
    import { tick, type Store } from "./store";
    export async function save(store: Store) {
      const before = store.get("a");
      store.set("a", before + "!");
      await tick();
      store.get("b");
    }
  ` });
  expect(report.stretches).toHaveLength(1);
  expect(report.stretches[0].fromStart).toBe(true);
  expect(labels(report.stretches[0].uses)).toEqual(["Store.get", "Store.set"]);
});

test("an await on only one branch doesn't end a stretch, and one on every branch does", () => {
  const report = audit({ "a.ts": `
    import { tick, type Store } from "./store";
    export async function some(store: Store, wait: boolean) {
      await tick();
      store.get("a");
      if (wait) await tick();
      store.set("a", "b");
    }
    export async function every(store: Store, wait: boolean) {
      await tick();
      store.get("a");
      if (wait) await tick(); else await tick();
      store.set("a", "b");
    }
    export async function orElse(store: Store) {
      await tick();
      store.get("a") ?? await tick();
      store.set("a", "b");
    }
  ` });
  expect(report.stretches.map((s) => [s.fn.name, s.fromStart, labels(s.uses)])).toEqual([
    ["some", false, ["Store.get", "Store.set"]],
    ["orElse", false, ["Store.get", "Store.set"]],
  ]);
});

test("a path that returns ends there, so it doesn't join what follows", () => {
  const report = audit({ "a.ts": `
    import { tick, type Store } from "./store";
    export async function early(store: Store) {
      await tick();
      if (!store.get("a")) return;
      await tick();
      store.set("a", "b");
    }
    export async function late(store: Store, done: boolean) {
      if (done) { store.get("a"); return; }
      store.set("a", "b");
    }
  ` });
  expect(report.stretches).toEqual([]);
});

test("a loop repeats a call between awaits, and joins the end of one pass to the start of the next", () => {
  const report = audit({ "a.ts": `
    import { tick, type Store } from "./store";
    export async function each(store: Store, keys: string[]) {
      await tick();
      for (const key of keys) store.get(key);
    }
    export async function across(store: Store, keys: string[]) {
      for (const key of keys) {
        store.get(key);
        await tick();
        store.set(key, "b");
      }
    }
    export async function apart(store: Store, keys: string[]) {
      for (const key of keys) {
        await tick();
        store.get(key);
        await tick();
      }
    }
    export async function skipped(store: Store, keys: string[]) {
      for (const key of keys) {
        if (store.get(key)) continue;
        await tick();
      }
    }
  ` });
  expect(report.stretches.map((s) => [s.fn.name, s.uses.map((u) => `${u.label}${u.repeated ? " repeats" : ""}`)])).toEqual([
    ["each", ["Store.get repeats"]],
    ["across", ["Store.get", "Store.set"]],
    ["skipped", ["Store.get repeats"]],
  ]);
});

test("a for await awaits before each pass, and a switch's cases each lead to what follows it", () => {
  const report = audit({ "a.ts": `
    import { tick, type Store } from "./store";
    export async function streamed(store: Store, keys: AsyncIterable<string>) {
      for await (const key of keys) store.get(key);
    }
    export async function picked(store: Store, kind: string) {
      await tick();
      switch (kind) {
        case "read": store.get("a"); break;
        case "write": store.set("a", "b"); return;
      }
      store.list();
    }
  ` });
  expect(report.stretches.map((s) => [s.fn.name, labels(s.uses)])).toEqual([["picked", ["Store.get", "Store.list"]]]);
});

test("a try's catch can follow any call in the try", () => {
  const report = audit({ "a.ts": `
    import { tick, type Store } from "./store";
    export async function recover(store: Store) {
      await tick();
      try { store.get("a"); await tick(); } catch { store.set("a", "b"); }
    }
  ` });
  expect(report.stretches.map((s) => labels(s.uses))).toEqual([["Store.get", "Store.set"]]);
});

test("array-method callbacks run in the stretch; an async one only until its first await", () => {
  const report = audit({ "a.ts": `
    import { tick, type Store } from "./store";
    export async function mapped(store: Store, keys: string[]) {
      await tick();
      return keys.map((key) => store.get(key));
    }
    export async function together(store: Store, keys: string[]) {
      await Promise.all(keys.map(async (key) => {
        store.get(key);
        await tick();
        store.set(key, "b");
      }));
    }
  ` });
  expect(report.stretches.map((s) => [s.fn.name, s.uses.map((u) => `${u.label}${u.repeated ? " repeats" : ""}`)])).toEqual([
    ["mapped", ["Store.get repeats"]],
    ["together", ["Store.get repeats"]],
  ]);
});

test("a sync helper's calls are one use where it's called, since R1 makes it one unit", () => {
  const report = audit({ "a.ts": `
    import { tick, type Store } from "./store";
    function bump(store: Store) { store.set("n", String(Number(store.get("n")) + 1)); }
    export async function twice(store: Store) {
      await tick();
      bump(store);
      await tick();
      bump(store);
      store.get("n");
    }
    export async function once(store: Store) {
      await tick();
      bump(store);
    }
  ` });
  expect(report.stretches.map((s) => [s.fn.name, labels(s.uses)])).toEqual([["twice", ["bump (a.ts:3)", "Store.get"]]]);
});

test("lists store calls in array-method callbacks and in positions that can't await", () => {
  const report = audit({ "a.ts": `
    import { createStore, type Store } from "./store";
    const store = createStore();
    export const keys = store.list();
    export function stale(store: Store, keys: string[]) { return keys.filter((key) => !store.get(key)); }
    export function named(store: Store, keys: string[]) {
      const known = (key: string) => store.get(key) !== null;
      return keys.some(known);
    }
    export function fallback(store: Store, value = store.get("default")) { return value; }
    export class Cache {
      constructor(private store: Store) { store.list(); }
      get first() { return this.store.get("first"); }
    }
    export class Snapshot { keys = store.list(); }
    export const getter = (store: Store) => ["a"].map(store.get);
  ` });
  expect(report.callbacks.map((c) => [c.line, c.position, labels(c.uses)])).toEqual([
    [4, "module scope", ["Store.list"]],
    [5, ".filter callback", ["Store.get"]],
    [10, "default parameter", ["Store.get"]],
    [12, "constructor", ["Store.list"]],
    [13, "getter", ["Store.get"]],
    [15, "field initializer", ["Store.list"]],
    [16, "method used as a value", ["Store.get"]],
  ]);
  // A function passed by name runs once per element, as a use in its caller.
  expect(fn(report, "named").uses).toEqual([{ file: "a.ts", line: 8, label: "named > known (a.ts:7)", helper: true }]);
});

test("lists BB's callbacks that use the store, those that must return synchronously first", () => {
  const report = audit({ "a.ts": `
    import { tick, type Store } from "./store";
    import type { Host } from "./host/sdk";
    export function plugin(host: Host, store: Store) {
      host.on("idle", async ({ id }) => { await tick(); store.set(id, "idle"); });
      const dispatched = ({ id }: { id: string }) => { store.get(id); };
      host.on("dispatched", dispatched);
      host.notify(() => { store.list(); });
      host.register({ name: "read", execute(input) { return store.get(String(input)) ?? ""; } });
      host.configure((context) => ({ tools: store.get(context.id) ? ["read"] : [] }));
      host.configure(() => ({ tools: [] }));
    }
  ` });
  expect(report.hostCallbacks.map((h) => [h.line, h.returns, h.async, h.registeredBy, labels(h.uses)])).toEqual([
    [10, "value", false, "host.configure()", ["Store.get"]],
    [8, "void", false, "host.notify()", ["Store.list"]],
    [5, "promise", true, "host.on(\"idle\")", ["Store.set"]],
    [6, "promise", false, "host.on(\"dispatched\")", ["Store.get"]],
    [9, "promise", false, "host.register().execute", ["Store.get"]],
  ]);
});

test("the report counts each section and prints every entry", () => {
  const text = formatAudit(audit({ "a.ts": `
    import { tick, type Store } from "./store";
    import type { Host } from "./host/sdk";
    export function plugin(host: Host, store: Store) {
      host.configure((context) => ({ tools: store.get(context.id) ? ["read"] : [] }));
      host.on("idle", async () => { store.get("a"); store.set("a", "b"); await tick(); });
    }
  ` }));
  expect(text).toBe(`Async audit of the Store's callers

Files audited: 2
Store call sites: 3 (plus 1 calls inside the store implementations, not audited)
(a) Functions that use the store: 2 (1 sync, 1 async); 2 call it directly
(b) R2 candidates: 1 stretches in 1 async functions; 1 run from the function's start; 0 repeat a call in a loop or callback
(c) Callbacks and positions that can't await: 0 (0 array-method callbacks, 0 of them predicates)
(d) BB callbacks that use the store: 2; 1 must return synchronously
    value: 1 (must return its result synchronously)
    promise: 1 (its type allows a Promise)

(a) Functions that use the store, with their store calls and the synchronous helpers they call that do
  a.ts:5  sync   plugin > callback to host.configure()  [1 direct, 0 via helpers]
      Store.get @5
  a.ts:6  async  plugin > callback to host.on("idle")  [2 direct, 0 via helpers]
      Store.get @6, Store.set @6

(b) Stretches between awaits that use the store twice or more
  a.ts:6  plugin > callback to host.on("idle")  [from the start]
      Store.get @6, Store.set @6

(c) Store use in array-method callbacks and positions that can't await

(d) BB callbacks that use the store
  a.ts:5  value   sync   host.configure()  (plugin > callback to host.configure())
      Store.get @5
  a.ts:6  promise async  host.on("idle")  (plugin > callback to host.on("idle"))
      Store.get @6, Store.set @6
`);
});
