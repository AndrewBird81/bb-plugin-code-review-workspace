/**
 * Make src/fixtures/1.7.0: reviews as 1.7.0 writes them, and what 1.7.0 reads of them, for src/data-1.7.0.test.ts.
 * A teammate's PR with a draft of three comments and feedback threads, your own PR with comments sent to a thread,
 * and a local review whose approval was sent, with settings that turn a knob off.
 *
 * Run it in a v1.7.0 checkout, as `git archive v1.7.0` gives it, after npm ci, from that checkout's root:
 * `npx vite-node scripts/fixture-1.7.0.ts <out dir>`. It writes data.sql, the rows 1.7.0 wrote, as SQL; reads.json,
 * scripts/store-dump.ts's reads of them; and payloads.json, the review each draft would post to GitHub.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../src/store";
import { queueStore } from "../src/store-queue";
import { toGithubReviewPayload } from "../src/draft";
import { targetKey } from "../src/targets";
import { defaultPreferences } from "../src/preferences";
import { dumpDatabase } from "./store-reads";

const [out] = process.argv.slice(2);
if (!out) {
  process.stderr.write("Usage: npx vite-node scripts/fixture-1.7.0.ts <out dir>\n");
  process.exit(2);
}

const PATCH = [
  "diff --git a/api.ts b/api.ts", "--- a/api.ts", "+++ b/api.ts", "@@ -1,3 +1,4 @@", "-const tries = 3;", "+const tries = 5;", "+retry(upload);", " send();", " done();",
  "diff --git a/util.ts b/util.ts", "--- a/util.ts", "+++ b/util.ts", "@@ -1,2 +1,2 @@", "-export const wait = 10;", "+export const wait = 100;", " export {};", "",
].join("\n");
const AT = 1_792_000_000_000;

const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
const store = queueStore(createStore(bb));

await store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, codeOwners: false } }, 0);

// A teammate's PR: the agent's comments and yours, a range across sides, a pre-existing problem, the agent's summary.
const teammate = targetKey({ kind: "pr", repo: "acme/web", number: 7 });
await store.saveReview({
  targetKey: teammate, kind: "pr", number: 7, repo: "acme/web", title: "Retry uploads", author: "per", base: "main", head: "per/retry",
  url: "https://github.com/acme/web/pull/7", status: "ready", createdAt: AT, projectId: "p1", headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
});
await store.savePatch(teammate, PATCH);
await store.setLifecycle(teammate, { prState: "OPEN", ownPr: false, reviewer: "casey", latestHeadSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", watchingSince: AT, pinnedAt: AT + 1 });
await store.upsertDraftComment(teammate, { file: "api.ts", line: 2, side: "RIGHT", severity: "should-fix", body: "Cap the retries." });
await store.upsertDraftComment(teammate, { file: "api.ts", line: 3, side: "RIGHT", startLine: 2, chapterId: "c1", author: "agent", severity: "blocking", body: "This drops the error.\n\n```suggestion\nsend().catch(report);\n```", evidence: "Read api.ts:3 and its callers." });
await store.upsertDraftComment(teammate, { file: "util.ts", line: 1, side: "RIGHT", startLine: 1, startSide: "LEFT", introduced: false, body: "This wait was already too long." });
await store.updateSummary(teammate, { body: "One blocker: errors are dropped.", bodyAuthor: "agent", suggestedVerdict: "REQUEST_CHANGES", written: { verdict: null, comments: "3:abc" }, unchecked: ["The upload tests"] });
await store.setVerdict(teammate, "REQUEST_CHANGES");
await store.saveSnapshot(teammate, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", PATCH);
await store.setFileViewed(teammate, "util.ts", "h-util", AT + 2);
await store.saveFeedbackThreads(teammate, [
  { id: "PRRT_1", commentId: 11, reviewId: "PRR_1", path: "api.ts", line: 2, originalLine: 1, startLine: null, side: "RIGHT", subjectType: "LINE", body: "Why 5?", createdAt: AT - 9_000, isResolved: false, resolvedBy: null, isOutdated: false, replies: [{ author: "per", bot: false, mine: false, body: "Our SLO, @casey?", createdAt: AT - 8_000 }], status: "question", replyAt: AT - 8_000 },
  { id: "PRRT_2", commentId: 12, reviewId: "PRR_1", path: null, line: null, originalLine: null, startLine: null, side: null, subjectType: "FILE", body: "Rename util.ts?", createdAt: AT - 7_000, isResolved: true, resolvedBy: "per", isOutdated: true, replies: [], status: "resolved", replyAt: null },
], AT - 1_000);
await store.setReplyDraft(teammate, "PRRT_1", "Yes, the upload SLO.", "agent");

// Your own PR, its comments sent to the thread that made the change.
const own = targetKey({ kind: "pr", repo: "acme/web", number: 9 });
await store.saveReview({
  targetKey: own, kind: "pr", number: 9, repo: "acme/web", title: "Fix login race", author: "casey", base: "main", head: "casey/login",
  url: "https://github.com/acme/web/pull/9", status: "ready", createdAt: AT + 10, projectId: "p1", headSha: "b2c3d4e5f60718293a4b5c6d7e8f901234567890",
});
await store.savePatch(own, PATCH);
await store.upsertDraftComment(own, { file: "api.ts", line: 2, side: "RIGHT", body: "Use the shared constant." });
await store.setLifecycle(own, {
  prState: "OPEN", ownPr: true, sourceThreadId: "thr_main", sourceThreadAt: AT + 11,
  sent: { at: AT + 12, threadId: "thr_main", title: "Fix login race", comments: [{ file: "api.ts", line: 2, side: "RIGHT", at: AT + 12, body: "Use the shared constant." }] },
});

// A local review, approved to the thread that made the change.
const local = targetKey({ kind: "ref", gitRef: "main...feature" }, { projectId: "p1", cwd: "/Users/casey/src/web" });
await store.saveReview({ targetKey: local, kind: "ref", gitRef: "main...feature", status: "ready", createdAt: AT + 20, projectId: "p1", cwd: "/Users/casey/src/web", headSha: "diff:9f8e7d" });
await store.savePatch(local, PATCH);
await store.updateSummary(local, { body: "Looks right." });
await store.setLifecycle(local, {
  name: "Upload retries", sourceThreadId: "thr_local", sourceThreadAt: AT + 21,
  approvalSent: { at: AT + 22, threadId: "thr_local", title: "Upload retries", revision: "rev-1" },
});

const db = bb.storage.database();
const dir = mkdtempSync(join(tmpdir(), "fixture-1.7.0-"));
const snapshot = join(dir, "data.db");
db.prepare(`VACUUM INTO ?`).run(snapshot);

// Each table's rows as INSERTs, in a fixed order, but the migrations' own record.
const quote = (value: unknown) => value === null ? "NULL" : typeof value === "number" || typeof value === "bigint" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_bb_migrations' ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name);
const sql = tables.flatMap((table) => {
  const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Array<Record<string, unknown>>;
  return rows.map((row) => `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(quote).join(", ")});`);
});
writeFileSync(join(out, "data.sql"), sql.join("\n") + "\n");

const { reads } = await dumpDatabase(snapshot);
writeFileSync(join(out, "reads.json"), reads);
const payloads: Record<string, unknown> = {};
for (const k of [teammate, own, local]) {
  const draft = await store.getDraft(k);
  payloads[k] = { plain: JSON.stringify(toGithubReviewPayload(draft, false, false)), preExisting: JSON.stringify(toGithubReviewPayload(draft, true, false)) };
}
writeFileSync(join(out, "payloads.json"), JSON.stringify(payloads, null, 2) + "\n");
await harness.dispose();
