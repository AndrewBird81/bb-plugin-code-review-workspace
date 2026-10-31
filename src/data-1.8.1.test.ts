// Reviews 1.8.1 wrote load on 1.9.0: src/fixtures/1.8.1 is scripts/fixture-1.8.0.ts's write from a v1.8.1 checkout, the
// rows it wrote, every Store read 1.8.1 gave of them, and what each draft posted to GitHub. Among them a folder's review
// that became its PR's, and two linked to their PR's own review, one with your notes.
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store";
import { queueStore } from "./store-queue";
import { toGithubReviewPayload } from "./draft";
import { checkFeature } from "./feature-review";
import { reviewNamed } from "./targets";
import { localIdOf } from "../lib/review-identity";
import { folderHost } from "./env-diff.test-support";
import { dumpDatabase } from "../scripts/store-reads";

// The fixture is a data.db's rows: the Store reads it on SQLite, whatever the test backend.
vi.unmock("./store");

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "1.8.1", name), "utf8");
const keys = JSON.parse(fixture("keys.json")) as { feature: string; own: string; teammate: string; converted: string; linked: Array<{ folder: string; pr: string }> };
const PATCH = [
  "diff --git a/api.ts b/api.ts", "--- a/api.ts", "+++ b/api.ts", "@@ -1,3 +1,4 @@", "-const tries = 3;", "+const tries = 5;", "+retry(upload);", " send();", " done();",
  "diff --git a/util.ts b/util.ts", "--- a/util.ts", "+++ b/util.ts", "@@ -1,2 +1,2 @@", "-export const wait = 10;", "+export const wait = 100;", " export {};", "",
].join("\n");

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/**
 * A host whose database holds the rows 1.8.1 wrote, gh answering for the PRs, and a folder on `branch` with a file the
 * PR doesn't have, no other thread in it.
 */
function host(branch: string) {
  const made = folderHost({ files: [{ path: "retry.ts" }], env: { branchName: branch } }, { threads: { list: async () => [], experimental_listDescendants: async () => ({ threads: [] }) } });
  createStore(made.bb);
  made.bb.storage.database().exec(fixture("data.sql"));
  const store = queueStore(createStore(made.bb));
  const view = (n: number) => ({ number: n, title: `Retry downloads ${n}`, author: { login: "casey" }, baseRefName: "main", headRefName: `casey/downloads-${n}`, url: `https://github.com/acme/web/pull/${n}`, headRefOid: "c3d4e5f60718293a4b5c6d7e8f90123456789abc", state: "OPEN" });
  const runGh = vi.fn(async (args: string[]) => ({ code: 0, stderr: "", stdout: args[1] === "diff" ? PATCH : JSON.stringify(view(Number(args[2]))) }));
  const deps = { bb: made.bb, store, gh: { runGh, runGit: vi.fn() } as any, changed: vi.fn(), sync: { one: vi.fn(async () => {}), health: () => ({ lastReadAt: null, error: null }) } };
  return { ...made, store, deps };
}

test("every Store read of reviews 1.8.1 wrote gives what 1.8.1's gave", async () => {
  const { bb, harness } = host("main");
  const dir = mkdtempSync(join(tmpdir(), "data-1.8.1-"));
  dirs.push(dir);
  bb.storage.database().prepare(`VACUUM INTO ?`).run(join(dir, "data.db"));
  await harness.dispose();
  expect(JSON.parse((await dumpDatabase(join(dir, "data.db"))).reads)).toEqual(JSON.parse(fixture("reads.json")));
});

test("each draft 1.8.1 wrote posts the same review, byte for byte, as a teammate's PR's and as your own", async () => {
  const { store } = host("main");
  const payloads = JSON.parse(fixture("payloads.json")) as Record<string, unknown>;
  expect(Object.keys(payloads)).toHaveLength(8);
  for (const [k, posted] of Object.entries(payloads)) {
    const draft = await store.getDraft(k);
    expect({ k, plain: JSON.stringify(toGithubReviewPayload(draft, false, false)), preExisting: JSON.stringify(toGithubReviewPayload(draft, true, false)), own: JSON.stringify(toGithubReviewPayload(draft, false, true)) })
      .toEqual({ k, ...posted as object });
  }
});

test("a 1.8.1 folder's review linked to its PR's review merges with it when read, with nothing of yours there, else offers to", async () => {
  const [empty, mine] = keys.linked;
  const { store, deps } = host("casey/downloads-22");
  await checkFeature(deps, empty.folder);
  const merged = (await store.getReview(empty.folder))!;
  expect(merged).toMatchObject({ kind: "pr", number: 22, became: { number: 22, merged: { comments: 0, summary: false, sends: 0 } } });
  expect(merged.feature?.prReview).toBeUndefined();
  expect(await store.getReview(empty.pr)).toMatchObject({ mergedInto: empty.folder, archivedAt: expect.any(Number) });
  expect((await store.getDraft(empty.folder)).comments.map((c) => c.body)).toEqual(["Retry downloads too, 22."]);

  const other = host("casey/downloads-23");
  await checkFeature(other.deps, mine.folder);
  const offering = (await other.store.getReview(mine.folder))!;
  expect(offering).toMatchObject({ kind: "ref", prOffer: { key: mine.pr, number: 23, url: "https://github.com/acme/web/pull/23" } });
  expect(offering.feature?.prReview).toBeUndefined();
  expect(await other.store.getReview(mine.pr)).not.toHaveProperty("mergedInto");
  expect((await other.store.getReviewerNotes(mine.pr)).body).toBe("Mine: check the timeouts.");
});

test("a review 1.8.1 made its PR's reads its folder for what isn't pushed yet, and answers to its id from before", async () => {
  const { bb, store, deps, calls } = host("casey/downloads-21");
  const converted = (await store.getReview(keys.converted))!;
  expect(converted).toMatchObject({ kind: "pr", number: 21, feature: { environmentId: "env_21", branch: "casey/downloads-21" } });
  expect(await checkFeature(deps, keys.converted)).toMatchObject({ state: "ahead", aheadFiles: 1, aheadPaths: ["retry.ts"] });
  expect(calls.length).toBeGreaterThan(0);
  const before = localIdOf({ ...converted, feature: converted.feature! });
  expect(before).toBe("web:casey/downloads-21");
  expect(await reviewNamed(store, bb, before)).toMatchObject({ targetKey: keys.converted });
});
