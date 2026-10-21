// Every Store call, reads included, waits its turn in one serial queue, so a caller's read-modify-write keeps the
// atomicity it had while Store calls were synchronous. store.exclusive(tx => …) holds the queue for a block of calls.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Store } from "./store";

/** The Store, each call resolving once its turn in the queue has run. */
export interface AsyncStore extends Store {
  /**
   * Run `fn` as one turn of the queue: nothing else reaches the store until it settles, and calls `fn` started but
   * didn't await have run. Inside, use `tx`: the outer store throws there, since it would wait for the block. On `tx`
   * this runs `fn` in the same block. Not a transaction: what ran before a throw stays.
   */
  exclusive<T>(fn: (tx: AsyncStore) => T | Promise<T>): Promise<T>;
}

export interface QueuedStore extends AsyncStore {
  /** Reject the queued calls and every later one, and resolve once the call or block running now ends. */
  dispose(): Promise<void>;
}

/** A call on a disposed store, or one still queued when it was disposed. */
export class StoreDisposedError extends Error {
  constructor() {
    super("The store was disposed");
    this.name = "StoreDisposedError";
  }
}

/** A running exclusive block. `tail` settles once its calls so far have run, and never rejects. */
interface Unit { open: boolean; tail: Promise<unknown> }

interface Job { run(): Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void }

export interface QueueOptions {
  /**
   * Runs inside each turn, after its call or block and before its caller resumes, so nothing else reaches the store
   * meanwhile. It reports its own failures: what it throws is dropped, and the call's own result stands.
   */
  afterTurn?(): void | Promise<void>;
}

const ignore = () => {};

/**
 * The queue over `backend`, whose own calls between its methods (`this.getReview`) don't go through it. `backend`'s
 * methods are its own function properties, as an object literal has them.
 */
export function queueStore(backend: Store, options: QueueOptions = {}): QueuedStore {
  const names = Object.keys(backend).filter((name) => typeof backend[name as keyof Store] === "function") as Array<keyof Store>;
  const call = (name: keyof Store, args: unknown[]) => (backend[name] as (...args: unknown[]) => unknown).apply(backend, args);
  const units = new AsyncLocalStorage<Unit>();
  const jobs: Job[] = [];
  let draining: Promise<void> | null = null;
  let disposed = false;

  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (disposed) return Promise.reject(new StoreDisposedError());
    const done = new Promise<T>((resolve, reject) => { jobs.push({ run, resolve: resolve as (value: unknown) => void, reject }); });
    draining ??= drain();
    return done;
  }

  async function drain() {
    // A call runs after its caller's synchronous code, as a query would.
    await Promise.resolve();
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      let settle: () => void;
      try {
        const value = await job.run();
        settle = () => job.resolve(value);
      } catch (error) {
        settle = () => job.reject(error);
      }
      try { await options.afterTurn?.(); } catch { /* the hook reports its own failures */ }
      settle();
    }
    draining = null;
  }

  function outside(what: string) {
    if (units.getStore()?.open) throw new Error(`store.${what} was called inside store.exclusive(), which it would wait for: use the block's tx`);
  }

  function blockStore(unit: Unit): AsyncStore {
    const open = (what: string) => {
      if (!unit.open) throw new Error(`tx.${what} was called after its store.exclusive() block ended`);
    };
    const tx = {
      exclusive<T>(fn: (tx: AsyncStore) => T | Promise<T>) {
        open("exclusive");
        return new Promise<T>((resolve) => { resolve(fn(tx)); });
      },
    } as AsyncStore;
    for (const name of names) {
      (tx as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        open(name);
        // In order, even when the block doesn't await each one.
        const result = unit.tail.then(() => call(name, args));
        unit.tail = result.then(ignore, ignore);
        return result;
      };
    }
    return tx;
  }

  const store = {
    exclusive<T>(fn: (tx: AsyncStore) => T | Promise<T>) {
      outside("exclusive");
      return enqueue(async () => {
        const unit: Unit = { open: true, tail: Promise.resolve() };
        try {
          return await units.run(unit, () => fn(blockStore(unit)));
        } finally {
          unit.open = false;
          await unit.tail;
        }
      });
    },
    async dispose() {
      disposed = true;
      for (const job of jobs.splice(0)) job.reject(new StoreDisposedError());
      await draining;
    },
  } as QueuedStore;
  for (const name of names) {
    (store as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      outside(name);
      return enqueue(async () => call(name, args));
    };
  }
  return store;
}
