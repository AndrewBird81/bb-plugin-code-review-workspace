import path from "node:path";
import { expect, test } from "vitest";
import { Project, ts } from "ts-morph";
import { formatPlan, planCodemod, repoOptions, type CodemodOptions, type CodemodPlan } from "./codemod-async-store";
import { queueStore } from "../src/store-queue";

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
`;

/** store-queue.ts's types, for the converted fixtures to compile against. */
const QUEUE = `
import type { Store } from "./store";
type Promised<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never };
export interface AsyncStore extends Promised<Store> { exclusive<T>(fn: (tx: AsyncStore) => T | Promise<T>): Promise<T> }
export declare function queueStore(backend: Store): AsyncStore;
`;

const VITEST = `
export declare function test(name: string, fn: () => void | Promise<void>): void;
export declare function expect(value: unknown): any;
`;

type Files = Record<string, string>;

function fixture(files: Files) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true, target: 9 /* ES2022 */ } });
  for (const [name, text] of Object.entries({ "store.ts": STORE, "queue.ts": QUEUE, "vitest.ts": VITEST, ...files })) project.createSourceFile(`/p/${name}`, text);
  return project;
}

/** Plans the codemod over store.ts, the queue's types, vitest's, and `files` (store.ts among them replaces the fixture store). */
function codemod(files: Files, options: Partial<CodemodOptions> = {}): CodemodPlan {
  return planCodemod(fixture(files), {
    root: "/p",
    storeInterfaces: [{ file: "store.ts", name: "Store" }],
    readMethods: new Set(["get", "list"]),
    queueModule: "queue.ts",
    storeFactory: { file: "store.ts", name: "createStore" },
    include: (filePath) => filePath !== "/p/queue.ts" && filePath !== "/p/vitest.ts",
    wrap: (filePath) => !filePath.endsWith(".test.ts"),
    ...options,
  });
}

const text = (plan: CodemodPlan, file = "a.ts") => plan.files.find((f) => f.file === file)?.text;
const unhandled = (plan: CodemodPlan) => plan.unhandled.map((u) => `${u.file}:${u.line} ${u.kind}`);
const lines = (...rows: string[]) => rows.join("\n") + "\n";

/** The compiler's errors in the converted fixture, as `file:line message`. */
function errors(files: Files, plan: CodemodPlan): string[] {
  const converted = Object.fromEntries(Object.entries(files).map(([name, original]) => [name, text(plan, name) ?? original]));
  return fixture(converted).getPreEmitDiagnostics().map((d) => `${d.getSourceFile()?.getBaseName()}:${d.getLineNumber()} ${ts.flattenDiagnosticMessageText(d.compilerObject.messageText, " ")}`);
}

/** Runs a converted fixture file, which imports nothing at runtime, and gives its exports. */
function load(source: string): Record<string, (...args: never[]) => Promise<unknown>> {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("exports", js)(exports);
  return exports;
}

/** The fixture Store's AsyncStore. */
interface FixtureStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; list(): Promise<string[]> }

/** A synchronous fixture store over a Map, put through the real queue. */
function queued(rows = new Map<string, string>()): FixtureStore {
  return queueStore({ get: (key: string) => rows.get(key) ?? null, set: (key: string, value: string) => { rows.set(key, value); }, list: () => [...rows.keys()] } as never) as unknown as FixtureStore;
}

const BUMP = lines(
  `import type { Store } from "./store";`,
  `export function bump(store: Store, key: string) {`,
  `  const value = store.get(key);`,
  `  store.set(key, value + "!");`,
  `}`,
  `export function read(store: Store) { return store.get("a")?.length; }`,
  `export function twice(store: Store) { bump(store, "a"); return read(store); }`,
  `export function pure(n: number) { return n + 1; }`,
);

test("awaits each store call and makes the functions that make one async, up the call chain; a body that takes two turns becomes one block", () => {
  const plan = codemod({ "a.ts": BUMP });
  // read takes one turn, and twice's call to bump is one too, but with read's it's two.
  expect(text(plan)).toBe(lines(
    `import type { AsyncStore } from "./queue";`,
    ``,
    `export async function bump(store: AsyncStore, key: string) {`,
    `  return store.exclusive(async (tx) => {`,
    `    const value = await tx.get(key);`,
    `    await tx.set(key, value + "!");`,
    `  });`,
    `}`,
    `export async function read(store: AsyncStore) { return (await store.get("a"))?.length; }`,
    `export async function twice(store: AsyncStore) { return store.exclusive(async (tx) => { await bump(tx, "a"); return await read(tx); }); }`,
    `export function pure(n: number) { return n + 1; }`,
  ));
  expect(plan.unhandled).toEqual([]);
  expect(errors({ "a.ts": BUMP }, plan)).toEqual([]);
  expect(plan.changes.filter((c) => c.kind === "async" || c.kind === "block").map((c) => [c.line, c.kind, c.name])).toEqual([
    [2, "async", "bump"], [2, "block", "bump"], [6, "async", "read"], [7, "async", "twice"], [7, "block", "twice"],
  ]);
});

test("R1's block keeps a read-modify-write whole on the queue, and a wrapped helper handed tx runs inside its caller's block", async () => {
  const wrapped = load(text(codemod({ "a.ts": BUMP }))!);
  const awaitsOnly = load(text(codemod({ "a.ts": BUMP }, { wrap: () => false }))!);
  const store = queued(new Map([["a", ""], ["b", ""]]));
  await Promise.all(Array.from({ length: 5 }, () => wrapped.bump(store as never, "a" as never)));
  await Promise.all(Array.from({ length: 5 }, () => awaitsOnly.bump(store as never, "b" as never)));
  // Without the block, each read waits behind the others, and every write writes what one read saw.
  expect([await store.get("a"), await store.get("b")]).toEqual(["!!!!!", "!"]);
  expect(await wrapped.twice(store as never)).toBe(6);
});

test("a function already async only gains awaits, a store call already awaited isn't awaited again, and one that returned a Promise becomes async while its callers stay", () => {
  const files = { "a.ts": lines(
    `import type { Store } from "./store";`,
    `export async function load(store: Store) { await store.get("a"); return store.list(); }`,
    `export function started(store: Store): Promise<number> { store.set("a", "b"); return Promise.resolve(1); }`,
    `export function caller(store: Store) { return started(store); }`,
  ) };
  const plan = codemod(files);
  expect(text(plan)).toBe(lines(
    `import type { AsyncStore } from "./queue";`,
    ``,
    `export async function load(store: AsyncStore) { await store.get("a"); return await store.list(); }`,
    `export async function started(store: AsyncStore): Promise<number> { await store.set("a", "b"); return Promise.resolve(1); }`,
    `export function caller(store: AsyncStore) { return started(store); }`,
  ));
  expect(errors(files, plan)).toEqual([]);
});

test("deps.store: the block runs on it, an alias or a store destructured from deps is tx, and deps carries tx into the helper it's handed to", () => {
  const files = { "a.ts": lines(
    `import type { Store } from "./store";`,
    `interface Deps { store: Store; name: string }`,
    `export function save(deps: Deps, key: string) {`,
    `  const value = deps.store.get(key);`,
    `  deps.store.set(key, value + deps.name);`,
    `  touch(deps, key);`,
    `}`,
    `function touch(deps: Deps, key: string) { deps.store.set(key, "touched"); }`,
    `export function destructured({ store }: Deps) { store.set("a", "1"); store.set("b", "2"); }`,
    `export function aliased(deps: Deps) {`,
    `  const { store } = deps;`,
    `  const s = deps.store;`,
    `  store.set("a", "1");`,
    `  s.set("b", "2");`,
    `}`,
    `export function picked(store: Pick<Store, "get" | "set">) { store.set("a", store.get("b") ?? ""); }`,
  ) };
  const plan = codemod(files);
  expect(text(plan)).toBe(lines(
    `import type { AsyncStore } from "./queue";`,
    ``,
    `interface Deps { store: AsyncStore; name: string }`,
    `export async function save(deps: Deps, key: string) {`,
    `  return deps.store.exclusive(async (tx) => {`,
    `    const value = await tx.get(key);`,
    `    await tx.set(key, value + deps.name);`,
    `    await touch({ ...deps, store: tx }, key);`,
    `  });`,
    `}`,
    `async function touch(deps: Deps, key: string) { await deps.store.set(key, "touched"); }`,
    `export async function destructured({ store }: Deps) { return store.exclusive(async (tx) => { await tx.set("a", "1"); await tx.set("b", "2"); }); }`,
    `export async function aliased(deps: Deps) {`,
    `  return deps.store.exclusive(async (tx) => {`,
    `    const { store } = deps;`,
    `    const s = tx;`,
    `    await tx.set("a", "1");`,
    `    await tx.set("b", "2");`,
    `  });`,
    `}`,
    // The block reads and writes: a Pick of the store picks exclusive too.
    `export async function picked(store: Pick<AsyncStore, "get" | "set" | "exclusive">) { return store.exclusive(async (tx) => { await tx.set("a", await tx.get("b") ?? ""); }); }`,
  ));
  expect(plan.unhandled).toEqual([]);
  expect(errors(files, plan)).toEqual([]);
});

test("a closure over the store that a block calls takes the store as its first parameter, and is handed tx there; one also used as a value is listed", () => {
  const files = { "a.ts": lines(
    `import { createStore } from "./store";`,
    `export function plugin() {`,
    `  const store = createStore();`,
    `  const draft = (key: string) => ({ value: store.get(key), all: store.list() });`,
    `  const loose = () => store.get("a");`,
    `  const kept = [loose];`,
    `  return {`,
    `    kept,`,
    `    save(key: string) { store.set(key, "x"); return draft(key); },`,
    `    read(key: string) { return draft(key); },`,
    `    check() { store.set("a", "b"); return loose(); },`,
    `  };`,
    `}`,
  ) };
  const plan = codemod(files);
  expect(text(plan)).toBe(lines(
    `import { createStore } from "./store";`,
    `import { queueStore, type AsyncStore } from "./queue";`,
    ``,
    `export function plugin() {`,
    `  const store = queueStore(createStore());`,
    `  const draft = async (store: AsyncStore, key: string) => store.exclusive(async (tx) => ({ value: await tx.get(key), all: await tx.list() }));`,
    `  const loose = async () => await store.get("a");`,
    `  const kept = [loose];`,
    `  return {`,
    `    kept,`,
    `    async save(key: string) { return store.exclusive(async (tx) => { await tx.set(key, "x"); return await draft(tx, key); }); },`,
    `    async read(key: string) { return await draft(store, key); },`,
    `    async check() { return store.exclusive(async (tx) => { await tx.set("a", "b"); return await loose(); }); },`,
    `  };`,
    `}`,
  ));
  expect(unhandled(plan)).toEqual(["a.ts:11 closure in block"]);
  expect(plan.unhandled[0].detail).toBe("plugin > loose (a.ts:5) reaches the store through its closure (`store` at a.ts:3), and the outer store throws inside this block");
  expect(plan.changes.filter((c) => c.kind === "lift").map((c) => c.detail)).toEqual(["takes `store` (a.ts:3) as its first parameter"]);
});

test("forEach statements become for…of loops over arrays and Maps, a return a continue; a map or flatMap that only reads becomes Promise.all", () => {
  const files = { "a.ts": lines(
    `import type { Store } from "./store";`,
    `export async function each(store: Store, keys: string[], byKey: Map<string, string>) {`,
    `  keys.forEach((key) => store.set(key, "1"));`,
    `  keys.forEach((key, i) => {`,
    `    if (!key) return;`,
    `    store.set(key, String(i));`,
    `  });`,
    `  byKey.forEach((value) => { store.set(value, "v"); });`,
    `  byKey.forEach((value, key) => { store.set(key, value); });`,
    `  const read = keys.map((key) => store.get(key));`,
    `  const flat = keys.flatMap((key) => [store.get(key), key]);`,
    `  return { read, flat };`,
    `}`,
  ) };
  const plan = codemod(files);
  expect(text(plan)).toBe(lines(
    `import type { AsyncStore } from "./queue";`,
    ``,
    `export async function each(store: AsyncStore, keys: string[], byKey: Map<string, string>) {`,
    `  for (const key of keys) await store.set(key, "1");`,
    `  for (const [i, key] of keys.entries()) {`,
    `    if (!key) continue;`,
    `    await store.set(key, String(i));`,
    `  }`,
    `  for (const value of byKey.values()) { await store.set(value, "v"); }`,
    `  for (const [key, value] of byKey.entries()) { await store.set(key, value); }`,
    `  const read = await Promise.all(keys.map(async (key) => await store.get(key)));`,
    `  const flat = (await Promise.all(keys.map(async (key) => [await store.get(key), key]))).flat();`,
    `  return { read, flat };`,
    `}`,
  ));
  expect(plan.unhandled).toEqual([]);
  expect(errors(files, plan)).toEqual([]);
  expect(plan.changes.filter((c) => c.kind === "loop" || c.kind === "promise-all").map((c) => [c.line, c.kind])).toEqual([
    [3, "loop"], [4, "loop"], [8, "loop"], [9, "loop"], [10, "promise-all"], [11, "promise-all"],
  ]);
});

test("array callbacks it can't rewrite faithfully are listed with why, and their awaits fail to compile there", () => {
  const files = { "a.ts": lines(
    `import type { Store } from "./store";`,
    `export async function each(store: Store, keys: string[]) {`,
    `  keys.forEach((key) => { for (const c of key) if (c === "x") return; store.set(key, "y"); });`,
    `  keys.forEach((key) => store.set(key, "1"), null);`,
    `  const written = keys.map((key) => { store.set(key, "2"); return key; });`,
    `  const seen: string[] = [];`,
    `  const pushed = keys.map((key) => { seen.push(key); return store.get(key); });`,
    `  const kept = keys.filter((key) => store.get(key) !== null);`,
    `  const maybe = (keys.length ? keys : undefined)?.map((key) => store.get(key));`,
    `  return { written, pushed, kept, maybe };`,
    `}`,
  ) };
  const plan = codemod(files);
  expect(plan.unhandled.map((u) => [u.line, u.kind, u.detail])).toEqual([
    [3, "array callback", ".forEach(…) reaches the store, and its callback returns from inside a loop"],
    [4, "array callback", ".forEach(…) reaches the store, and it's given a this argument"],
    [5, "array callback", ".map(…) reaches the store, and its callbacks write to the store, so running them together could make writes a throw would have stopped"],
    [7, "array callback", ".map(…) reaches the store, and its callbacks change `seen`, declared outside them, so running them together could change the order of that"],
    [8, "array callback", ".filter(…) reaches the store, and .filter needs each callback's answer before it goes on"],
    [9, "array callback", ".map(…) reaches the store, and it's an optional call"],
  ]);
  // The converted file's import takes a line more.
  expect(errors(files, plan).map((e) => e.split(" ")[0])).toEqual(["a.ts:4", "a.ts:5", "a.ts:6", "a.ts:8", "a.ts:9", "a.ts:10"]);
});

test("store calls where nothing can await are listed: module scope, a default parameter, a constructor, an accessor; so is a type predicate", () => {
  const files = { "a.ts": lines(
    `import { createStore, type Store } from "./store";`,
    `const shared = createStore();`,
    `export const first = shared.get("a");`,
    `export function withDefault(store: Store, value = store.get("a")) { return value; }`,
    `export class Holder {`,
    `  constructor(private store: Store) { store.get("a"); }`,
    `  get value() { return this.store.get("b"); }`,
    `}`,
    `export function isSet(store: Store, key: string): key is "a" { return store.get(key) !== null; }`,
  ) };
  expect(unhandled(codemod(files))).toEqual([
    "a.ts:3 sync position", "a.ts:4 default parameter", "a.ts:6 sync position", "a.ts:6 sync position",
    "a.ts:7 sync position", "a.ts:7 sync position", "a.ts:9 type predicate",
  ]);
});

test("a function made async handed where its result is needed synchronously, or where a Promise goes unwatched, is listed; one handed where a Promise is allowed isn't", () => {
  const files = { "a.ts": lines(
    `import type { Store } from "./store";`,
    `export function register(store: Store, on: (handler: () => string | null) => void, run: (fn: () => void) => void, later: (fn: () => Promise<void> | void) => void) {`,
    `  on(() => store.get("a"));`,
    `  run(() => { store.set("c", "d"); });`,
    `  later(() => { store.set("a", "b"); });`,
    `  const typed: () => string | null = () => store.get("z");`,
    `  return typed;`,
    `}`,
  ) };
  const plan = codemod(files);
  expect(plan.unhandled.map((u) => [u.line, u.kind, u.detail])).toEqual([
    [3, "sync callback", "handed to on(), which expects its result synchronously"],
    [4, "sync callback", "handed to run(), which expects no result, so its Promise would go unwatched"],
    [6, "sync callback", "typed, whose declared type expects its result synchronously"],
  ]);
  // The converted file's import takes a line more; run's callback compiles, and its Promise goes unwatched.
  expect(errors(files, plan).map((e) => e.split(" ")[0])).toEqual(["a.ts:4", "a.ts:7"]);
});

test("async work a block starts without awaiting keeps the outer store and is listed, as are a helper handed tx that starts such work and a function the block makes", () => {
  const files = { "a.ts": lines(
    `import type { Store } from "./store";`,
    `export async function refresh(store: Store) { await Promise.resolve(); store.set("r", "1"); }`,
    `export function startRefresh(store: Store) { store.set("a", "1"); void refresh(store); }`,
    `export function save(store: Store) {`,
    `  store.set("a", "1");`,
    `  store.set("b", "2");`,
    `  void refresh(store);`,
    `}`,
    `export function viaHelper(store: Store) { store.set("a", "1"); startRefresh(store); }`,
    `export function later(store: Store, schedule: (fn: () => Promise<void>) => void) {`,
    `  store.set("a", "1");`,
    `  store.set("b", "2");`,
    `  schedule(() => { store.set("c", "3"); });`,
    `}`,
    `export function started(store: Store): Promise<void> {`,
    `  store.set("a", "1");`,
    `  store.set("b", "2");`,
    `  return refresh(store);`,
    `}`,
  ) };
  const plan = codemod(files);
  expect(text(plan)).toBe(lines(
    `import type { AsyncStore } from "./queue";`,
    ``,
    `export async function refresh(store: AsyncStore) { await Promise.resolve(); await store.set("r", "1"); }`,
    `export async function startRefresh(store: AsyncStore) { await store.set("a", "1"); void refresh(store); }`,
    `export async function save(store: AsyncStore) {`,
    `  return store.exclusive(async (tx) => {`,
    `    await tx.set("a", "1");`,
    `    await tx.set("b", "2");`,
    `    void refresh(store);`,
    `  });`,
    `}`,
    `export async function viaHelper(store: AsyncStore) { return store.exclusive(async (tx) => { await tx.set("a", "1"); await startRefresh(tx); }); }`,
    `export async function later(store: AsyncStore, schedule: (fn: () => Promise<void>) => void) {`,
    `  return store.exclusive(async (tx) => {`,
    `    await tx.set("a", "1");`,
    `    await tx.set("b", "2");`,
    `    schedule(async () => { await store.set("c", "3"); });`,
    `  });`,
    `}`,
    `export async function started(store: AsyncStore): Promise<void> {`,
    `  await store.set("a", "1");`,
    `  await store.set("b", "2");`,
    `  return refresh(store);`,
    `}`,
  ));
  expect(plan.unhandled.map((u) => [u.line, u.kind, u.detail])).toEqual([
    [7, "detached in block", "refresh (a.ts:2) is async, reaches the store, and isn't awaited here: it keeps the outer store, which throws if reached while the block runs, so start it after the block"],
    [9, "detached in block", "startRefresh (a.ts:3) starts refresh (a.ts:3) and doesn't await it: handed the block's tx, that work finds it stale once the block ends"],
    [13, "nested function in block", "later > callback to schedule() reaches the store and can run after the block or alongside it; its store is left as the outer one"],
    [15, "returns a promise", "it returned a Promise already, which a block would hold the queue for until it settles; it isn't wrapped"],
  ]);
});

test("a body that uses two stores isn't wrapped, and a helper's closure over the store is listed where a block calls it", () => {
  const files = { "a.ts": lines(
    `import type { Store } from "./store";`,
    `export function both(store: Store, other: Store) { store.set("a", "1"); other.set("b", "2"); }`,
    `function makeHelper(store: Store) { return () => store.set("x", "y"); }`,
    `export function viaClosure(store: Store) {`,
    `  const helper = makeHelper(store);`,
    `  helper();`,
    `  helper();`,
    `}`,
  ) };
  const plan = codemod(files);
  expect(unhandled(plan)).toEqual(["a.ts:2 several stores", "a.ts:6 closure in block", "a.ts:7 closure in block"]);
  expect(text(plan)).toContain(`export async function both(store: AsyncStore, other: AsyncStore) { await store.set("a", "1"); await other.set("b", "2"); }`);
});

test("tests gain awaits but no blocks, createStore goes through queueStore, and expect(() => …).toThrow() awaits the rejection", () => {
  const files = {
    "a.ts": lines(
      `import type { Store } from "./store";`,
      `export function save(store: Store, key: string) {`,
      `  if (!key) throw new Error("empty");`,
      `  store.set(key, (store.get("a") ?? "") + "!");`,
      `}`,
    ),
    "a.test.ts": lines(
      `import { expect, test } from "./vitest";`,
      `import { createStore } from "./store";`,
      `import { save } from "./a";`,
      `function seeded() {`,
      `  const store = createStore();`,
      `  store.set("a", "1");`,
      `  return store;`,
      `}`,
      `test("saves", () => {`,
      `  const store = seeded();`,
      `  save(store, "b");`,
      `  expect(store.get("b")).toBe("1!");`,
      `  expect(() => save(store, "")).toThrow("empty");`,
      `  expect(() => { save(store, "c"); }).not.toThrow();`,
      `  expect(save).toThrow();`,
      `});`,
    ),
  };
  const plan = codemod(files);
  expect(text(plan, "a.test.ts")).toBe(lines(
    `import { expect, test } from "./vitest";`,
    `import { createStore } from "./store";`,
    `import { save } from "./a";`,
    `import { queueStore } from "./queue";`,
    ``,
    `async function seeded() {`,
    `  const store = queueStore(createStore());`,
    `  await store.set("a", "1");`,
    `  return store;`,
    `}`,
    `test("saves", async () => {`,
    `  const store = await seeded();`,
    `  await save(store, "b");`,
    `  expect(await store.get("b")).toBe("1!");`,
    `  await expect(save(store, "")).rejects.toThrow("empty");`,
    `  await expect((async () => { await save(store, "c"); })()).resolves.not.toThrow();`,
    `  expect(save).toThrow();`,
    `});`,
  ));
  expect(plan.unhandled.map((u) => [u.file, u.line, u.kind, u.detail])).toEqual([
    ["a.test.ts", 15, "sync callback", "expect(fn).toThrow() calls it and gets a Promise, which never throws: await expect(fn()).rejects.toThrow() instead"],
  ]);
  expect(errors(files, plan)).toEqual([]);
});

test("the store's implementation and the functions it calls stay synchronous; their other callers, stand-ins and store methods taken as values are listed", () => {
  const store = STORE.replace("  list(): string[];\n}", "  list(): string[];\n  size(): number;\n}")
    .replace("    list() { return [...rows.keys()]; },\n", "    list() { return [...rows.keys()]; },\n    size() { return countAll(this); },\n")
    + "export function countAll(store: Store) { return store.list().length; }\n";
  const files = { "store.ts": store, "a.ts": lines(
    `import { countAll, type Store } from "./store";`,
    `export function report(store: Store) { return countAll(store); }`,
    `export function standIn(): Store { return { get: () => null, set() {}, list: () => [], size: () => 0 }; }`,
    `export function cast() { return {} as Store; }`,
    `export function methods(store: Store) {`,
    `  const get = store.get;`,
    `  const { list } = store;`,
    `  return [get, list];`,
    `}`,
  ) };
  const plan = codemod(files);
  expect(plan.files.map((f) => f.file)).toEqual(["a.ts"]);
  expect(unhandled(plan)).toEqual([
    "a.ts:2 pinned", "a.ts:3 store stand-in", "a.ts:4 store stand-in", "a.ts:6 method as value", "a.ts:7 method as value", "store.ts:17 pinned",
  ]);
  expect(text(plan)).toContain("export function cast() { return {} as Store; }");
});

test("Store becomes AsyncStore, but not as an indexed type; ReturnType of createStore is AsyncStore, and of a function made async, Awaited", () => {
  const files = { "a.ts": lines(
    `import { createStore, type Store } from "./store";`,
    `export type Reader = Pick<Store, "get">;`,
    `export type Getter = Store["get"];`,
    `export type Made = ReturnType<typeof createStore>;`,
    `export function readAll(store: Store) { return store.list().map((key) => key.length); }`,
    `export type All = ReturnType<typeof readAll>;`,
  ) };
  const plan = codemod(files);
  expect(text(plan)).toBe(lines(
    `import { createStore, type Store } from "./store";`,
    `import type { AsyncStore } from "./queue";`,
    ``,
    `export type Reader = Pick<AsyncStore, "get">;`,
    `export type Getter = Store["get"];`,
    `export type Made = AsyncStore;`,
    `export async function readAll(store: AsyncStore) { return (await store.list()).map((key) => key.length); }`,
    `export type All = Awaited<ReturnType<typeof readAll>>;`,
  ));
  expect(errors(files, plan)).toEqual([]);
});

test("a body's comments, blank lines and template literal lines stay as they were, indented with the block; overloads return Promises too; an untouched file isn't in the plan", () => {
  const files = {
    "a.ts": lines(
      `import type { Store } from "./store";`,
      ``,
      `/** Keeps comments. */`,
      `export function tidy(store: Store, key: string) {`,
      `  // First the read.`,
      `  const before = store.get(key);`,
      ``,
      "  const text = `line one",
      "line two ${before}`;",
      `  store.set(key, text); // trailing comment`,
      `  // After the last statement.`,
      `}`,
      `export function pick(store: Store): string;`,
      `export function pick(store: Store, key?: string): string;`,
      `export function pick(store: Store, key = "a") { return store.get(key) ?? ""; }`,
    ),
    "b.ts": `export const unrelated = 1;\n`,
  };
  const plan = codemod(files);
  expect(text(plan)).toBe(lines(
    `import type { AsyncStore } from "./queue";`,
    ``,
    `/** Keeps comments. */`,
    `export async function tidy(store: AsyncStore, key: string) {`,
    `  return store.exclusive(async (tx) => {`,
    `    // First the read.`,
    `    const before = await tx.get(key);`,
    ``,
    "    const text = `line one",
    "line two ${before}`;",
    `    await tx.set(key, text); // trailing comment`,
    `    // After the last statement.`,
    `  });`,
    `}`,
    `export function pick(store: AsyncStore): Promise<string>;`,
    `export function pick(store: AsyncStore, key?: string): Promise<string>;`,
    `export async function pick(store: AsyncStore, key = "a") { return await store.get(key) ?? ""; }`,
  ));
  expect(plan.files.map((f) => f.file)).toEqual(["a.ts"]);
  expect(errors(files, plan)).toEqual([]);
});

test("formatPlan prints the counts, each file's changes, the functions made async, the array rewrites, and what's left with why", () => {
  const plan = codemod({ "a.ts": lines(
    `import type { Store } from "./store";`,
    `export function save(store: Store, keys: string[]) {`,
    `  keys.forEach((key) => store.set(key, "1"));`,
    `  return keys.filter((key) => store.get(key));`,
    `}`,
  ) });
  expect(formatPlan(plan)).toBe(lines(
    `Codemod: the Store's callers onto the AsyncStore`,
    ``,
    `Files changed: 1`,
    `  async: 1`,
    `  block: 1`,
    `  lift: 0`,
    `  await: 2`,
    `  loop: 1`,
    `  promise-all: 0`,
    `  expect: 0`,
    `  type: 1`,
    `  queue: 0`,
    `Unhandled: 1`,
    `  array callback: 1`,
    ``,
    `Per file: async / block / lift / await / loop / promise-all / expect / type / queue`,
    `  a.ts  1 / 1 / 0 / 2 / 1 / 0 / 0 / 1 / 0`,
    ``,
    `Functions made async, with each R1 block`,
    `  a.ts:2  save  [R1 block]`,
    ``,
    `Array callbacks rewritten`,
    `  a.ts:3  loop .forEach(…)  in save`,
    ``,
    `Unhandled, for a hand fix`,
    `  a.ts:4  [array callback]  in save`,
    `      .filter(…) reaches the store, and .filter needs each callback's answer before it goes on`,
  ));
});

test("this repo's read methods are the Store methods the store dump reads, and the codemod's own files are left out", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const options = repoOptions(root);
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
  const methods = new Set(options.storeInterfaces.flatMap(({ file, name }) =>
    project.addSourceFileAtPath(path.join(root, file)).getInterfaceOrThrow(name).getMethods().map((m) => m.getName())));
  const dump = project.addSourceFileAtPath(path.join(root, "scripts/store-reads.ts")).getFunctionOrThrow("dumpStoreReads");
  const dumped = new Set(dump.getDescendantsOfKind(ts.SyntaxKind.PropertyAccessExpression)
    .filter((access) => access.getExpression().getText() === "store" && methods.has(access.getName())).map((access) => access.getName()));
  expect([...options.readMethods].sort()).toEqual([...dumped].sort());
  for (const own of ["scripts/codemod-async-store.ts", "scripts/codemod-async-store.test.ts", "src/store-queue.ts"]) expect(options.include(path.join(root, own))).toBe(false);
  expect(options.wrap(path.join(root, "src/store.test.ts"))).toBe(false);
  expect(options.wrap(path.join(root, "e2e/review-flow.test.ts"))).toBe(false);
  expect(options.wrap(path.join(root, "server.ts"))).toBe(true);
});
