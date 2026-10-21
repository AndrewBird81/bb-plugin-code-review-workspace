import { test, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, type ReviewMeta } from "./store";
import { queueStore, StoreDisposedError, type StoreBackend } from "./store-queue";

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 1); });

/** A backend whose calls each take a timer tick, logging when each starts and ends. */
function slowBackend() {
  const log: string[] = [];
  const reviews = new Map<string, ReviewMeta>();
  const backend = {
    async getReview(k: string) {
      log.push(`start get ${k}`);
      await tick();
      log.push(`end get ${k}`);
      return reviews.get(k) ?? null;
    },
    async saveReview(meta: ReviewMeta) {
      log.push(`start save ${meta.targetKey}`);
      await tick();
      reviews.set(meta.targetKey, meta);
      log.push(`end save ${meta.targetKey}`);
    },
    listReviews() {
      log.push("list");
      return [...reviews.values()];
    },
    hasPatch(k: string): boolean {
      throw new Error(`no patch for ${k}`);
    },
    async patch(k: string): Promise<string> {
      await tick();
      throw new Error(`no patch for ${k}`);
    },
  };
  return { log, store: queueStore(backend as unknown as StoreBackend) };
}

const review = (targetKey: string): ReviewMeta => ({ targetKey, kind: "pr", number: 1, status: "ready", createdAt: 1 });

test("calls run one at a time in the order they were made, reads included", async () => {
  const { log, store } = slowBackend();
  await Promise.all([store.getReview("a"), store.saveReview(review("a")), store.getReview("a"), store.listReviews()]);
  expect(log).toEqual(["start get a", "end get a", "start save a", "end save a", "start get a", "end get a", "list"]);
});

test("a call runs after its caller's synchronous code", async () => {
  const { log, store } = slowBackend();
  const listed = store.listReviews();
  log.push("caller");
  await listed;
  expect(log).toEqual(["caller", "list"]);
});

test("an exclusive block holds the queue until it settles", async () => {
  const { log, store } = slowBackend();
  const block = store.exclusive(async (tx) => {
    const before = await tx.getReview("a");
    await tx.saveReview(review("a"));
    return before;
  });
  const after = store.getReview("a");
  await expect(block).resolves.toBeNull();
  await expect(after).resolves.toMatchObject({ targetKey: "a" });
  expect(log).toEqual(["start get a", "end get a", "start save a", "end save a", "start get a", "end get a"]);
});

test("a block's calls run in order and finish before the queue moves on, awaited or not", async () => {
  const { log, store } = slowBackend();
  const block = store.exclusive(async (tx) => {
    void tx.saveReview(review("a"));
    await Promise.all([tx.getReview("a"), tx.saveReview(review("b"))]);
    void tx.getReview("b");
  });
  const after = store.listReviews();
  await Promise.all([block, after]);
  expect(log).toEqual([
    "start save a", "end save a", "start get a", "end get a", "start save b", "end save b", "start get b", "end get b", "list",
  ]);
});

test("exclusive on a block's tx runs in the same block", async () => {
  const { log, store } = slowBackend();
  const block = store.exclusive(async (tx) => {
    await tx.saveReview(review("a"));
    return tx.exclusive(async (inner) => { await inner.saveReview(review("b")); return (await inner.listReviews()).length; });
  });
  const after = store.getReview("c");
  await expect(block).resolves.toBe(2);
  await after;
  expect(log).toEqual(["start save a", "end save a", "start save b", "end save b", "list", "start get c", "end get c"]);
});

test("the outer store throws inside an exclusive block instead of waiting for it", async () => {
  const { store } = slowBackend();
  await expect(store.exclusive(() => store.getReview("a"))).rejects.toThrow("store.getReview was called inside store.exclusive()");
  await expect(store.exclusive(async (tx) => {
    await tx.getReview("a");
    return store.exclusive(() => 1);
  })).rejects.toThrow("store.exclusive was called inside store.exclusive()");
  // Nor further in, in a nested block or a callback.
  await expect(store.exclusive((tx) => tx.exclusive(async () => { await tick(); return store.listReviews(); })))
    .rejects.toThrow("store.listReviews was called inside store.exclusive()");
  // The queue is free again.
  await expect(store.getReview("a")).resolves.toBeNull();
});

test("work a block started but didn't wait for can use the outer store once the block ends", async () => {
  const { log, store } = slowBackend();
  let later: Promise<unknown> | undefined;
  await store.exclusive(async (tx) => {
    later = (async () => { await tick(); await tick(); return store.listReviews(); })();
    await tx.saveReview(review("a"));
  });
  await expect(later).resolves.toHaveLength(1);
  expect(log).toEqual(["start save a", "end save a", "list"]);
});

test("a block's tx throws once the block has ended", async () => {
  const { store } = slowBackend();
  const tx = await store.exclusive((tx) => tx);
  expect(() => tx.getReview("a")).toThrow("tx.getReview was called after its store.exclusive() block ended");
  expect(() => tx.exclusive(() => 1)).toThrow("tx.exclusive was called after its store.exclusive() block ended");
});

test("another store's queue is its own", async () => {
  const one = slowBackend();
  const other = slowBackend();
  await expect(one.store.exclusive(async (tx) => {
    await other.store.saveReview(review("a"));
    return (await tx.listReviews()).length + (await other.store.listReviews()).length;
  })).resolves.toBe(1);
});

test("a call that throws or rejects releases the queue, and its caller gets the error", async () => {
  const { log, store } = slowBackend();
  const thrown = store.hasPatch("a");
  const rejected = store.patch("a");
  const after = store.listReviews();
  await expect(thrown).rejects.toThrow("no patch for a");
  await expect(rejected).rejects.toThrow("no patch for a");
  await expect(after).resolves.toEqual([]);
  expect(log).toEqual(["list"]);
});

test("a block that throws or rejects releases the queue", async () => {
  const { store } = slowBackend();
  const failure = new Error("failed");
  const thrown = store.exclusive(() => { throw failure; });
  const rejected = store.exclusive(async (tx) => { await tx.saveReview(review("a")); throw failure; });
  const failedCall = store.exclusive((tx) => tx.patch("a"));
  const after = store.getReview("a");
  await expect(thrown).rejects.toBe(failure);
  await expect(rejected).rejects.toBe(failure);
  await expect(failedCall).rejects.toThrow("no patch for a");
  // Not a transaction: the save before the throw stays.
  await expect(after).resolves.toMatchObject({ targetKey: "a" });
});

test("dispose rejects the queued calls and later ones, after the running call ends", async () => {
  const { log, store } = slowBackend();
  const running = store.saveReview(review("a"));
  let ran = false;
  const queued = Promise.allSettled([store.getReview("a"), store.exclusive(() => { ran = true; })]);
  await tick();
  expect(log).toEqual(["start save a"]);
  const disposed = store.dispose();
  for (const call of await queued) expect(call).toMatchObject({ status: "rejected", reason: expect.any(StoreDisposedError) });
  await disposed;
  expect(log).toEqual(["start save a", "end save a"]);
  await expect(running).resolves.toBeUndefined();
  expect(ran).toBe(false);
  await expect(store.listReviews()).rejects.toBeInstanceOf(StoreDisposedError);
  await expect(store.exclusive(() => 1)).rejects.toBeInstanceOf(StoreDisposedError);
  await expect(store.dispose()).resolves.toBeUndefined();
  expect(log).toEqual(["start save a", "end save a"]);
});

test("a block running at dispose finishes its calls, and dispose waits for it", async () => {
  const { log, store } = slowBackend();
  let disposed: Promise<void> | undefined;
  const block = store.exclusive(async (tx) => {
    await tx.saveReview(review("a"));
    disposed = store.dispose();
    await tx.saveReview(review("b"));
    return (await tx.listReviews()).length;
  });
  const queued = expect(store.getReview("a")).rejects.toBeInstanceOf(StoreDisposedError);
  await expect(block).resolves.toBe(2);
  await disposed;
  await queued;
  expect(log).toEqual(["start save a", "end save a", "start save b", "end save b", "list"]);
});

test("dispose with nothing queued resolves", async () => {
  const { store } = slowBackend();
  await expect(store.dispose()).resolves.toBeUndefined();
});

test("over the synchronous Store, it gives each method's result, its own calls between methods included", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const sync = createStore(bb);
  const store = queueStore(sync);
  for (const name of Object.keys(sync)) expect(typeof (store as unknown as Record<string, unknown>)[name], name).toBe("function");
  await store.saveReview(review("pr-1"));
  await store.setLifecycle("pr-1", { name: "Mine" });
  await expect(store.getReview("pr-1")).resolves.toEqual(sync.getReview("pr-1"));
  expect(sync.getReview("pr-1")?.name).toBe("Mine");
  // saveReviewerNotes finds the review with this.getReview.
  await expect(store.saveReviewerNotes("pr-1", "notes", 0)).resolves.toEqual({ body: "notes", revision: 1 });
  await expect(store.saveReviewerNotes("pr-2", "notes", 0)).rejects.toThrow("Review not found.");
  await expect(store.exclusive(async (tx) => {
    await tx.setStatus("pr-1", "generating");
    return (await tx.listReviews()).map((r) => r.status);
  })).resolves.toEqual(["generating"]);
  await expect(store.getReview("missing")).resolves.toBeNull();
});
