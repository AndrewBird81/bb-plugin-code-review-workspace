import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../src/store";
import { canonical, dumpDatabase, tableChecksums } from "./store-reads";

const RENAMED = "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n";
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A snapshot of a store with a review whose reads write: its patch's hash is missing, and its rows are under a renamed file's old path. */
async function snapshot(): Promise<string> {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "o/r", status: "ready", createdAt: 1, headSha: "h1" });
  store.setLifecycle("pr-1", { pinnedAt: 5 });
  store.savePatch("pr-1", RENAMED);
  store.setFileViewed("pr-1", "old.ts", "x", 7);
  store.upsertDraftComment("pr-1", { file: "new.ts", line: 1, side: "RIGHT", body: "why b?", author: "agent" });
  store.addDiscussionMessage("pr-1", { file: "old.ts", line: 1, side: "RIGHT" }, "reviewer", "why?");
  store.saveSnapshot("pr-1", "h1", RENAMED);
  store.saveAssessmentRun("pr-1", { headSha: "h1", summary: "ok", suggestedVerdict: null, suggestedBody: "", assessedAt: 9 });
  const id = store.beginGeneration("pr-1");
  store.setGenerationWorker("pr-1", id, "worker-1");
  store.setAssistantThread("pr-1", "thread-1");
  store.ignoreDiscovery("pr-2");
  const db = bb.storage.database();
  db.prepare(`UPDATE patches SET hash=NULL`).run();
  const dir = mkdtempSync(join(tmpdir(), "store-reads-test-"));
  dirs.push(dir);
  const path = join(dir, "data.db");
  db.prepare(`VACUUM INTO ?`).run(path);
  await harness.dispose();
  return path;
}

test("dumping the same database twice gives identical output, from a copy, with the reads that write", async () => {
  const source = await snapshot();
  const bytes = readFileSync(source);
  const first = await dumpDatabase(source);
  expect(await dumpDatabase(source)).toEqual(first);
  expect(readFileSync(source).equals(bytes)).toBe(true);

  const reads = JSON.parse(first.reads);
  expect(Object.keys(reads.reviews)).toEqual(["pr-1", "pr-2"]);
  expect(reads.global.generationOf).toEqual({ "thread-1": null, "worker-1": "pr-1" });
  const review = reads.reviews["pr-1"];
  expect(review.getReview).toMatchObject({ targetKey: "pr-1", pinnedAt: 5 });
  expect(review.patchHash).toBe(sha256(RENAMED));
  expect(review.patch).toEqual({ length: RENAMED.length, sha256: sha256(RENAMED) });
  expect(review.getSnapshot).toEqual({ h1: { length: RENAMED.length, sha256: sha256(RENAMED) } });
  expect(Object.values(review.isCurrentGeneration)).toEqual([true]);
  expect(review.getFileViews).toEqual([{ file: "new.ts", hash: "x", viewedAt: 7 }]);
  expect(review.fileHashes.files).toEqual(["new.ts"]);
  expect(review.locations.map((l: { at: unknown }) => l.at)).toEqual([{ file: "new.ts", line: 1, side: "RIGHT" }, { file: "old.ts", line: 1, side: "RIGHT" }]);
  expect(reads.reviews["pr-2"].isDiscoveryIgnored).toBe(true);

  // The reads stored the patch's hash and moved the rows to the new path, in the copy.
  const { source: dumped, before, after } = JSON.parse(first.checksums);
  expect(dumped).toEqual({ bytes: bytes.length, sha256: sha256(bytes) });
  const changed = Object.keys(before).filter((table) => before[table].sha256 !== after[table].sha256);
  expect(changed).toEqual(["discussion_entries", "discussion_waits", "file_views", "patches"]);
});

test("a database with a WAL file isn't dumped", async () => {
  const source = await snapshot();
  writeFileSync(`${source}-wal`, "");
  await expect(dumpDatabase(source)).rejects.toThrow("has a WAL file");
});

test("a table's checksum depends on its values and their types, not the order of its rows or columns", () => {
  const checksum = (create: string, rows: unknown[][]) => {
    const db = new Database(":memory:");
    db.exec(create);
    for (const row of rows) db.prepare(`INSERT INTO t VALUES (?,?)`).run(...row);
    const { t } = tableChecksums(db);
    db.close();
    return t;
  };
  const ab = checksum(`CREATE TABLE t (a, b)`, [[1, "x"], [2, null]]);
  expect(ab).toMatchObject({ columns: ["a", "b"], rows: 2 });
  expect(checksum(`CREATE TABLE t (b, a)`, [[null, 2], ["x", 1]])).toEqual(ab);
  expect(checksum(`CREATE TABLE t (a, b)`, [["1", "x"], [2, null]]).sha256).not.toBe(ab.sha256);
  expect(checksum(`CREATE TABLE t (a, b)`, [[1, "x"], [2, ""]]).sha256).not.toBe(ab.sha256);
  expect(checksum(`CREATE TABLE t (a, b)`, [[1.5, "x"], [2, null]]).sha256).not.toBe(ab.sha256);
});

test("canonical keeps Maps in order and what JSON would lose, and sorts object keys", () => {
  expect(canonical({ b: 1, a: [undefined, 2n], c: undefined, d: new Map<string, unknown>([["z", 1], ["y", new Set([2])]]) })).toEqual({
    a: [{ $undefined: true }, { $bigint: "2" }],
    b: 1,
    d: { $map: [["z", 1], ["y", { $set: [2] }]] },
  });
  expect(JSON.stringify(canonical({ b: 1, a: 2 }))).toBe(`{"a":2,"b":1}`);
});
