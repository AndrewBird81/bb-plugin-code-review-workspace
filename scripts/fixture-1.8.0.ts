/**
 * The reverse of scripts/fixture-1.7.0.ts: a database 1.8.0 wrote, with every kind of data 1.8.0 adds, read with
 * 1.7.0's code, as a rollback to 1.7.0 would. A folder's review with its main thread, two Sends and their `send:<n>`
 * snapshots, and comments open, sent, resolved and dismissed, reported on; your own PR with a fixer, GitHub threads
 * sent to it, Not pushed yet, a Push GitHub moved past and a merge waiting in Ready to approve; a teammate's PR with an
 * approve waiting there and the review agent's activity; and settings with 1.8.0's three switches off.
 *
 * `npx vite-node scripts/fixture-1.8.0.ts write <out dir>`, from this checkout's root, writes data.db, a consistent
 * snapshot, and keys.json, what the reader checks it against. With CRW_TEST_PG_URL naming a throwaway Postgres
 * (scripts/test-postgres.sh), it writes the same reviews to its schema crw_fixture_180 too. Run in a v1.8.1 checkout,
 * its data.sql, reads.json, payloads.json and keys.json are src/fixtures/1.8.1, for src/data-1.8.1.test.ts: with a
 * folder's review that became its PR's, and two linked to their PR's own review, one with your notes.
 *
 * `npx vite-node scripts/fixture-1.8.0.ts read <out dir>`, with this file copied into a v1.7.0 checkout, as
 * `git archive v1.7.0` gives it, after npm ci, from that checkout's root: 1.7.0's Store reads of data.db (and, with
 * CRW_TEST_PG_URL, of the schema), the review each draft would post, what 1.7.0's own writes keep, and the plugin
 * opening, editing and submitting the reviews with a stand-in gh and git first on PATH, which log every call. It writes
 * what it read beside data.db, prints a line per check, and exits 1 if any fails. docs/fixture-1.8.0.md has the whole run.
 */
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore, reanchorDraft, storeOn } from "../src/store";
import { queueStore, type AsyncStore } from "../src/store-queue";
import { toGithubReviewPayload, type CommentLocation, type Draft } from "../src/draft";
import { targetKey } from "../src/targets";
import { defaultPreferences } from "../src/preferences";
import { pruneDiffs } from "../src/feedback-view";
import { pgSql } from "../src/db/pg";
import { sqliteSql, type Sql } from "../src/db/sql";
import { testPgOptions, testPgUrl } from "../src/db/pg-test.test-support";
import { dumpDatabase, dumpStoreReads, formatDump, storeEntities } from "./store-reads";

const [mode, out] = process.argv.slice(2);
if (mode !== "write" && mode !== "read" || !out) {
  process.stderr.write("Usage: npx vite-node scripts/fixture-1.8.0.ts write|read <out dir>\n");
  process.exit(2);
}

const SCHEMA = "crw_fixture_180";
const AT = 1_793_000_000_000;
const HEAD = "c3d4e5f60718293a4b5c6d7e8f90123456789abc";
const PATCH = [
  "diff --git a/api.ts b/api.ts", "--- a/api.ts", "+++ b/api.ts", "@@ -1,3 +1,4 @@", "-const tries = 3;", "+const tries = 5;", "+retry(upload);", " send();", " done();",
  "diff --git a/util.ts b/util.ts", "--- a/util.ts", "+++ b/util.ts", "@@ -1,2 +1,2 @@", "-export const wait = 10;", "+export const wait = 100;", " export {};", "",
].join("\n");
// The folder after an Update: a file added, the rest as it was.
const UPDATED = PATCH + ["diff --git a/retry.ts b/retry.ts", "new file mode 100644", "--- /dev/null", "+++ b/retry.ts", "@@ -0,0 +1,1 @@", "+export const retry = () => {};", ""].join("\n");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The reviews, and each comment's tracking as 1.8.0 wrote it, for the reader. */
interface Keys {
  feature: string; own: string; teammate: string;
  /** A folder's review that became PR #21's; folders' reviews linked to #22's review, with nothing of yours, and #23's, with your notes. */
  converted: string; linked: Array<{ folder: string; pr: string }>;
  /** The feature review's patch: what it shows, its last read of the folder. */
  featurePatch: string;
  comments: Record<string, Array<CommentLocation & { id?: string; state?: string }>>;
  sendSnapshots: Record<string, string[]>;
  knobs: Record<string, boolean>;
}

/** The reviews as 1.8.0 writes them, through its store. */
async function writeReviews(store: AsyncStore): Promise<Keys> {
  // 1.7.0 has none of these modules, so the reader never loads them.
  const { featureKey } = await import("../src/targets");
  const { sendKey } = await import("../lib/send-baseline");
  const { diffFilesHead } = await import("../src/env-diff");
  const { NOT_PUSHED } = await import("../lib/push");
  const knobs = { reviewAgentActs: false, reviewChangesLine: false, trackOwnPrs: false };
  await store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, ...knobs } }, 0);
  const files = (patch: string) => ({ revisions: { "api.ts": `rev-api-${patch.length}`, "util.ts": "rev-util" }, hidden: [{ path: ".env.local", reason: "secret" as const }] });

  // A folder's review: kind "ref" with no cwd, its main thread adopted, two Sends, then an Update between them.
  const feature = featureKey("env_fixture", "casey/upload-retries");
  await store.saveReview({ targetKey: feature, kind: "ref", gitRef: "casey/upload-retries", title: "Retry uploads", status: "ready", createdAt: AT, projectId: "p1" });
  const main = { threadId: "thr_main", environmentId: "env_fixture", origin: "adopted" as const, since: AT };
  await store.setLifecycle(feature, {
    feature: { environmentId: "env_fixture", hostId: "host_maxbook", machine: "MaxBook", path: "/Users/casey/src/web", branch: "casey/upload-retries", baseRef: "main", mergeBaseRef: "0123456789abcdef0123456789abcdef01234567", repo: "acme/web", changedFiles: null },
    mainThread: main, implementers: [{ threadId: "thr_before", environmentId: "env_fixture", origin: "adopted", since: AT - 5_000 }],
    sourceThreadId: "thr_main", sourceThreadAt: AT, includeHidden: [".env.example"], flaggedSeen: ["config/secrets.yml"],
  });
  await store.savePatch(feature, PATCH);
  await store.saveSnapshotFiles(feature, diffFilesHead(await store.patchHash(feature)), files(PATCH));
  const at = (file: string, line: number): CommentLocation => ({ file, line, side: "RIGHT" });
  await store.upsertDraftComment(feature, { ...at("api.ts", 1), severity: "should-fix", body: "Cap the retries." });
  await store.upsertDraftComment(feature, { ...at("api.ts", 2), author: "agent", severity: "blocking", body: "Retry only on a network error.", evidence: "Read api.ts:2." });
  await store.upsertDraftComment(feature, { ...at("api.ts", 3), body: "Log the failure." });
  await store.upsertDraftComment(feature, { ...at("api.ts", 4), body: "Say done once." });
  await store.trackComments(feature, [
    { at: at("api.ts", 1), id: "c1", state: "sent", sendN: 1 },
    { at: at("api.ts", 2), id: "c2", state: "sent", sendN: 1, editedBy: "agent" },
    { at: at("api.ts", 3), id: "c3", state: "sent", sendN: 1 },
    { at: at("api.ts", 4), id: "c4", state: "sent", sendN: 1 },
  ]);
  await store.saveSnapshot(feature, sendKey(1), PATCH);
  await store.saveSnapshotFiles(feature, sendKey(1), files(PATCH));
  // The reports, then your clicks: c2 resolved, c3 dismissed, c4 reopened; then an Update, and a second Send.
  await store.trackComments(feature, [
    { at: at("api.ts", 1), claim: { outcome: "done", note: "Capped at 5.", commit: "1111111111111111111111111111111111111111", threadId: "thr_main", at: AT + 100 } },
    { at: at("api.ts", 2), state: "resolved", claim: { outcome: "done", threadId: "thr_sub", at: AT + 101 } },
    { at: at("api.ts", 3), state: "dismissed", claim: { outcome: "declined", note: "The caller logs it.", threadId: "thr_main", at: AT + 102 } },
    { at: at("api.ts", 4), state: "open", claim: { outcome: "done", threadId: null, at: AT + 103, inferred: true } },
  ]);
  await store.savePatch(feature, UPDATED);
  await store.rebaseDraftComments(feature, await reanchorDraft(store, feature, PATCH, UPDATED));
  await store.saveSnapshotFiles(feature, diffFilesHead(await store.patchHash(feature)), files(UPDATED));
  await store.upsertDraftComment(feature, { file: "util.ts", line: 1, side: "RIGHT", body: "Not sent yet." });
  // Your edit opens c1 again, for the second Send; c4 stays open, reopened, until the next.
  await store.upsertDraftComment(feature, { ...at("api.ts", 1), severity: "should-fix", body: "Cap the retries at 3." });
  await store.trackComments(feature, [{ at: at("api.ts", 1), state: "sent", sendN: 2, claim: undefined }]);
  await store.saveSnapshot(feature, sendKey(2), UPDATED);
  await store.saveSnapshotFiles(feature, sendKey(2), files(UPDATED));
  await store.setLifecycle(feature, {
    sends: [
      { n: 1, at: AT + 50, threadId: "thr_main", ids: ["c1", "c2", "c3", "c4"], readyAt: AT + 110, readyBy: { from: "main" }, checkedAt: AT + 120 },
      { n: 2, at: AT + 200, threadId: "thr_main", ids: ["c1"], queued: "msg_q2", letPush: true },
    ],
    sent: { at: AT + 200, threadId: "thr_main", title: "Retry uploads", comments: [{ ...at("api.ts", 1), body: "Cap the retries at 3.", at: AT + 200 }] },
    fixes: { sent: 1, reported: 0, inferred: 0, checked: 0, fixed: 0 },
    letPush: true,
    push: { state: "pushed", at: AT + 300, threadId: "thr_main", repo: "acme/web", head: "casey/upload-retries", sha: "2222222222222222222222222222222222222222" },
    remoteHead: { repo: "acme/web", head: "casey/upload-retries", sha: "2222222222222222222222222222222222222222", at: AT + 301 },
    activity: [{ at: AT + 50, text: "Sent 4 comments to Retry uploads", asking: "direct" }],
  });

  // Your own PR: once a folder's review, its folder gone; a fixer at its head, GitHub threads sent to it, Not pushed yet.
  const own = targetKey({ kind: "pr", repo: "acme/web", number: 12 });
  await store.saveReview({
    targetKey: own, kind: "pr", number: 12, repo: "acme/web", title: "Fix login race", author: "casey", base: "main", head: "casey/login",
    gitRef: "main...casey/login", url: "https://github.com/acme/web/pull/12", status: "ready", createdAt: AT + 10, projectId: "p1", headSha: HEAD,
  });
  await store.savePatch(own, PATCH);
  await store.saveSnapshot(own, HEAD, PATCH);
  await store.upsertDraftComment(own, { ...at("api.ts", 1), body: "Open: still to send." });
  await store.upsertDraftComment(own, { ...at("api.ts", 2), body: "Sent: use the shared constant." });
  await store.upsertDraftComment(own, { ...at("api.ts", 3), body: "Resolved: log it." });
  await store.upsertDraftComment(own, { ...at("api.ts", 4), severity: "nit", body: "Dismissed: rename it." });
  await store.trackComments(own, [
    { at: at("api.ts", 2), id: "c5", state: "sent", sendN: 1 },
    { at: at("api.ts", 3), id: "c6", state: "resolved", sendN: 1, claim: { outcome: "done", commit: "3333333333333333333333333333333333333333", threadId: "thr_fixer", at: AT + 400 } },
    { at: at("api.ts", 4), id: "c7", state: "dismissed", sendN: 1, claim: { outcome: "declined", note: "Out of scope.", threadId: "thr_fixer", at: AT + 401 } },
  ]);
  await store.saveSnapshot(own, sendKey(1), PATCH);
  await store.saveSnapshotFiles(own, NOT_PUSHED, files(PATCH));
  await store.saveFeedbackThreads(own, [
    { id: "PRRT_7", commentId: 71, reviewId: "PRR_7", path: "util.ts", line: 1, originalLine: 1, startLine: null, side: "RIGHT", subjectType: "LINE", body: "Why 100?", createdAt: AT - 9_000, isResolved: false, resolvedBy: null, isOutdated: false, replies: [], status: "open", replyAt: null, author: "per" },
  ], AT - 1_000);
  await store.setLifecycle(own, {
    prState: "OPEN", ownPr: true, reviewer: "casey", latestHeadSha: HEAD, watchingSince: AT,
    feature: { environmentId: "env_login", hostId: "host_maxbook", machine: "MaxBook", path: "/Users/casey/src/web-login", branch: "casey/login", baseRef: "main", repo: "acme/web", folderGone: true },
    mainThread: { threadId: "thr_fixer", environmentId: "env_fixer", origin: "fresh", since: AT + 300, branch: "bb/fixes-thr_fixer", fixer: { sha: HEAD, at: AT + 300 } },
    implementers: [{ threadId: "thr_login", environmentId: "env_login", origin: "adopted", since: AT + 10 }],
    sourceThreadId: "thr_fixer", sourceThreadAt: AT + 300,
    sends: [{ n: 1, at: AT + 310, threadId: "thr_fixer", ids: ["c5", "c6", "c7", "c8"], patch: "--- a/api.ts\n+++ b/api.ts\n@@ -3 +3 @@\n-send();\n+send().catch(log);\n", readyAt: AT + 420, letPush: true, coverClosed: true }],
    threadSends: { PRRT_7: { id: "c8", sendN: 1, claim: { outcome: "done", note: "Matches the SLO.", threadId: "thr_fixer", at: AT + 402 } } },
    sent: { at: AT + 310, threadId: "thr_fixer", title: "Fixes for web#12 · Fix login race", comments: [{ ...at("api.ts", 2), body: "Sent: use the shared constant.", at: AT + 310 }] },
    notPushedSeen: { environmentId: "env_fixer", base: HEAD, at: AT + 430 },
    keptBranches: [{ branch: "bb/login-thr_login", machine: "MaxBook", path: "/Users/casey/src/web", at: AT + 305 }],
    prConversation: [{ id: "IC_1", kind: "comment", author: "per", bot: false, body: "Can this land today?", at: AT + 5, url: "https://github.com/acme/web/pull/12#issuecomment-1", waiting: true }],
    headFork: null,
    push: { state: "flagged", at: AT + 500, threadId: "thr_fixer", repo: "acme/web", head: "casey/login", flag: "unrequested", remote: "4444444444444444444444444444444444444444", fixer: true },
    remoteHead: { repo: "acme/web", head: "casey/login", sha: "4444444444444444444444444444444444444444", at: AT + 500 },
    readyToApprove: { action: "merge", verdict: null, body: "", comments: [], headSha: HEAD, merge: { method: "squash", auto: true, deleteBranch: true }, token: "tok-merge", from: "thr_orch", fromTitle: "Orchestrate", at: AT + 600 },
    activity: [
      { at: AT + 402, text: "Posted a reply on util.ts:1", asking: "direct", url: "https://github.com/acme/web/pull/12#discussion_r72" },
      { at: AT + 403, text: "Resolved a thread on util.ts:1", asking: "relayed", from: "thr_orch", fromTitle: "Orchestrate" },
    ],
  });

  // A teammate's PR: an approve relayed from another thread, waiting in Ready to approve, and a Send that posts nothing.
  const teammate = targetKey({ kind: "pr", repo: "acme/web", number: 15 });
  await store.saveReview({
    targetKey: teammate, kind: "pr", number: 15, repo: "acme/web", title: "Add upload metrics", author: "per", base: "main", head: "per/metrics",
    url: "https://github.com/acme/web/pull/15", status: "ready", createdAt: AT + 20, projectId: "p1", headSha: HEAD,
  });
  await store.savePatch(teammate, PATCH);
  await store.saveSnapshot(teammate, HEAD, PATCH);
  await store.upsertDraftComment(teammate, { ...at("api.ts", 2), severity: "should-fix", body: "Count the retries." });
  await store.trackComments(teammate, [{ at: at("api.ts", 2), id: "c9", state: "sent", sendN: 1 }]);
  await store.saveSnapshot(teammate, sendKey(1), PATCH);
  await store.setVerdict(teammate, "APPROVE", "Looks good once the retries are counted.");
  await store.setLifecycle(teammate, {
    prState: "OPEN", ownPr: false, reviewer: "casey", latestHeadSha: HEAD, watchingSince: AT,
    sends: [{ n: 1, at: AT + 700, threadId: "thr_fix15", ids: ["c9"] }],
    readyToApprove: { action: "approve", verdict: "APPROVE", body: "Thanks, looks good.", comments: [{ path: "api.ts", line: 2, side: "RIGHT", body: "Nice." }], headSha: HEAD, token: "tok-approve", from: "thr_orch", fromTitle: "Orchestrate", at: AT + 710 },
    activity: [{ at: AT + 705, text: "Drafted 1 comment", asking: "unattended" }],
  });

  // A folder's review becomes its PR's, as 1.8.0 makes it, gh answering for #21: or links to the PR's own review.
  // `read` runs in a v1.7.0 checkout, which has no becomePr; 1.9.0's takes more.
  const { becomePr: become } = await import("../src/feature-review");
  const becomePr = become as unknown as (deps: unknown, key: string, pr: { repo: string; number: number }) => Promise<string>;
  const view = (n: number) => ({ number: n, title: `Retry downloads ${n}`, author: { login: "casey" }, baseRefName: "main", headRefName: `casey/downloads-${n}`, url: `https://github.com/acme/web/pull/${n}`, headRefOid: HEAD, state: "OPEN" });
  const gh = { runGh: async (args: string[]) => ({ code: 0, stderr: "", stdout: args[1] === "diff" ? PATCH : JSON.stringify(view(Number(args[2]))) }) };
  const folderReview = async (n: number) => {
    const k = featureKey(`env_${n}`, `casey/downloads-${n}`);
    await store.saveReview({ targetKey: k, kind: "ref", gitRef: `casey/downloads-${n}`, title: `Retry downloads ${n}`, status: "ready", createdAt: AT + 30 + n, projectId: "p1" });
    await store.setLifecycle(k, {
      feature: { environmentId: `env_${n}`, hostId: "host_maxbook", machine: "MaxBook", path: `/Users/casey/src/web-${n}`, branch: `casey/downloads-${n}`, baseRef: "main", repo: "acme/web", changedFiles: null },
      mainThread: { threadId: `thr_${n}`, environmentId: `env_${n}`, origin: "adopted", since: AT + 30 },
    });
    await store.savePatch(k, PATCH);
    await store.upsertDraftComment(k, { ...at("api.ts", 2), body: `Retry downloads too, ${n}.` });
    return k;
  };
  const converted = await folderReview(21);
  const linked: Keys["linked"] = [];
  for (const n of [22, 23]) {
    const pr = targetKey({ kind: "pr", repo: "acme/web", number: n });
    await store.saveReview({ targetKey: pr, kind: "pr", number: n, repo: "acme/web", title: `Retry downloads ${n}`, author: "casey", url: `https://github.com/acme/web/pull/${n}`, status: "tracked", createdAt: AT + 25, projectId: "p1" });
    if (n === 23) await store.saveReviewerNotes(pr, "Mine: check the timeouts.", 0);
    linked.push({ folder: await folderReview(n), pr });
  }
  for (const [k, n, became] of [[converted, 21, "converted"], ...linked.map(({ folder }, i) => [folder, 22 + i, "linked"] as const)] as const) {
    const result = await becomePr({ store, gh, changed: () => {} }, k, { repo: "acme/web", number: n });
    if (result !== became) throw new Error(`${k} ${result}, not ${became}`);
  }

  const comments: Keys["comments"] = {};
  const sendSnapshots: Keys["sendSnapshots"] = {};
  for (const k of [feature, own, teammate, converted, ...linked.flatMap(({ folder, pr }) => [folder, pr])]) {
    comments[k] = (await store.getDraft(k)).comments.map(({ file, line, side, id, state }) => ({ file, line, side, ...id ? { id } : {}, ...state ? { state } : {} }));
    sendSnapshots[k] = [];
    for (const n of [1, 2]) if (await store.getSnapshot(k, sendKey(n)) !== null) sendSnapshots[k].push(sendKey(n));
  }
  return { feature, own, teammate, converted, linked, featurePatch: sha256(UPDATED), comments, sendSnapshots, knobs };
}

if (mode === "write") {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = queueStore(createStore(bb));
  const keys = await writeReviews(store);
  // The review each draft would post, as a teammate's PR's and as your own.
  const payloads: Record<string, unknown> = {};
  for (const k of Object.keys(keys.comments)) {
    const draft = await store.getDraft(k);
    payloads[k] = { plain: JSON.stringify(toGithubReviewPayload(draft, false, false)), preExisting: JSON.stringify(toGithubReviewPayload(draft, true, false)), own: JSON.stringify(toGithubReviewPayload(draft, false, true)) };
  }
  await store.dispose();
  rmSync(join(out, "data.db"), { force: true });
  const db = bb.storage.database();
  db.prepare(`VACUUM INTO ?`).run(join(out, "data.db"));
  writeFileSync(join(out, "keys.json"), formatDump(keys));
  // As scripts/fixture-1.7.0.ts writes src/fixtures/1.7.0: each table's rows as INSERTs, but the migrations' own record;
  // and every Store read of them.
  const quote = (value: unknown) => value === null ? "NULL" : typeof value === "number" || typeof value === "bigint" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_bb_migrations' ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name);
  const inserts = tables.flatMap((table) => (db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Array<Record<string, unknown>>)
    .map((row) => `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(quote).join(", ")});`));
  writeFileSync(join(out, "data.sql"), inserts.join("\n") + "\n");
  writeFileSync(join(out, "reads.json"), (await dumpDatabase(join(out, "data.db"))).reads);
  writeFileSync(join(out, "payloads.json"), JSON.stringify(payloads, null, 2) + "\n");
  await harness.dispose();
  if (testPgUrl) {
    const { migratePg } = await import("../src/db/pg-migrations");
    const admin = pgSql(testPgOptions("public"));
    await admin.run(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.end();
    const pg = pgSql(testPgOptions(SCHEMA));
    await migratePg(pg, SCHEMA);
    const pgStore = queueStore(storeOn(pg));
    await writeReviews(pgStore);
    await pgStore.dispose();
    await pg.end();
  }
  process.stdout.write(`Wrote ${join(out, "data.db")} and keys.json${testPgUrl ? `, and Postgres schema ${SCHEMA}` : ""}\n`);
  process.exit(0);
}

// read: 1.7.0's code.
const keys = JSON.parse(readFileSync(join(out, "keys.json"), "utf8")) as Keys;
const results: Array<{ backend: string; check: string; ok: boolean; detail?: unknown }> = [];
const check = (backend: string, name: string, ok: boolean, detail?: unknown) => {
  results.push({ backend, check: name, ok, ...detail === undefined ? {} : { detail } });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} [${backend}] ${name}${!ok && detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}\n`);
};
const json = (value: unknown) => JSON.stringify(value);
const throwsIn = (reads: string) => [...reads.matchAll(/"\$throws": "([^"]*)"/g)].map((m) => m[1]);

// gh and git that log every call, first on PATH, so nothing reaches GitHub and any git the plugin runs shows. git
// always fails; gh answers only what Submit asks, as @casey, and keeps the review it would post.
const standIns = mkdtempSync(join(tmpdir(), "fixture-1.8.0-bin-"));
const calls = join(standIns, "calls.log");
const posts = join(standIns, "posts");
const submit = [
  `case "$*" in`,
  `  "auth token --hostname github.com --user casey") echo fixture-token; exit 0;;`,
  `  "api user --jq .login") echo casey; exit 0;;`,
  `  "pr view "*" --json headRefOid,baseRefName,reviewDecision,state -R acme/web") echo '{"headRefOid":"${HEAD}","baseRefName":"main","state":"OPEN"}'; exit 0;;`,
  `  "api -X POST repos/acme/web/pulls/"*"/reviews --input -") cat > "${posts}-$$.json"; echo '{"node_id":"PRR_fixture","user":{"login":"casey"}}'; exit 0;;`,
  `esac`,
];
for (const bin of ["gh", "git"]) {
  writeFileSync(join(standIns, bin), ["#!/bin/sh", `echo "${bin} $*" >> "${calls}"`, ...bin === "gh" ? submit : [], "exit 99", ""].join("\n"));
  chmodSync(join(standIns, bin), 0o755);
}
writeFileSync(calls, "");
process.env.PATH = [standIns, process.env.PATH].join(delimiter);
const ran = (bin: string) => readFileSync(calls, "utf8").split("\n").filter((line) => line.startsWith(`${bin} `));

/** The Store checks, on either backend: what each draft posts, and what 1.7.0's own writes keep of 1.8.0's. */
// `read` runs in a v1.7.0 checkout, so this is 1.7.0's signature: no `own`, and preExisting optional.
const payload170 = toGithubReviewPayload as unknown as (draft: Draft, preExisting?: boolean) => ReturnType<typeof toGithubReviewPayload>;

async function storeChecks(backend: string, store: AsyncStore, sql: Sql) {
  const reviews = [keys.feature, keys.own, keys.teammate];
  const payloads: Record<string, unknown> = {};
  for (const k of reviews) {
    const draft = await store.getDraft(k);
    payloads[k] = { plain: payload170(draft), preExisting: payload170(draft, true) };
    // 1.7.0 posts every comment in the draft, whatever 1.8.0 says of its fix.
    const posted = payload170(draft).comments.map((c) => `${c.path}:${c.line}:${c.side}`);
    const settled = keys.comments[k].filter((c) => c.state && c.state !== "open");
    check(backend, `${k}: the payload posts every comment, the ${[...new Set(settled.map((c) => c.state))].join(", ") || "none"} ones too`,
      keys.comments[k].every((c) => posted.includes(`${c.file}:${c.line}:${c.side}`)) && posted.length === keys.comments[k].length, { posted, comments: keys.comments[k] });
  }
  writeFileSync(join(out, `payloads-1.7.0-${backend}.json`), formatDump(payloads));

  // A write of 1.7.0's own keeps every lifecycle key it doesn't know.
  const lifecycle = async (k: string) => JSON.parse((await sql.get<{ state: string }>(`SELECT state FROM review_lifecycle WHERE target_key=?`, [k]))!.state) as Record<string, unknown>;
  for (const k of reviews) {
    const before = await lifecycle(k);
    await store.setLifecycle(k, { pinnedAt: AT + 999 });
    const after = await lifecycle(k);
    check(backend, `${k}: 1.7.0's setLifecycle keeps 1.8.0's keys (${Object.keys(before).length} keys)`, json(after) === json({ ...before, pinnedAt: AT + 999 }), { before, after });
  }
  // Saving settings in 1.7.0 keeps the switches it doesn't know.
  const savedKnobs = async () => JSON.parse((await sql.get<{ knobs: string }>(`SELECT knobs FROM review_preferences WHERE id=1`))!.knobs) as Record<string, unknown>;
  const knobsBefore = await savedKnobs();
  const { preferences, revision } = await store.getPreferences();
  await store.savePreferences({ ...preferences, guideDetail: preferences.guideDetail === "concise" ? "detailed" : "concise" }, revision);
  const knobsAfter = await savedKnobs();
  check(backend, "1.7.0's savePreferences keeps reviewAgentActs, reviewChangesLine and trackOwnPrs off",
    Object.entries(keys.knobs).every(([knob, value]) => knobsBefore[knob] === value && knobsAfter[knob] === value), { knobsBefore, knobsAfter });

  // 1.7.0's prune keeps the heads it knows, so it drops the Sends' snapshots.
  for (const k of reviews) {
    await pruneDiffs(store, (await store.getReview(k))!);
    const left: string[] = [];
    for (const head of keys.sendSnapshots[k]) if (await store.getSnapshot(k, head) !== null) left.push(head);
    check(backend, `${k}: 1.7.0's prune drops the send snapshots (${keys.sendSnapshots[k].join(", ") || "none"})`, left.length === 0, { left });
  }
}

const db = new Database(join(out, "data.db"), { readonly: true, fileMustExist: true });
const entities = storeEntities(db);
db.close();

// SQLite: 1.7.0's reads dump, then the Store checks and the plugin, each on a copy.
const { reads } = await dumpDatabase(join(out, "data.db"));
writeFileSync(join(out, "reads-1.7.0-sqlite.json"), reads);
check("sqlite", "every Store read of 1.8.0's data, with no error", throwsIn(reads).length === 0, throwsIn(reads));

const copy = (made: ReturnType<typeof createFakePluginHost>) => {
  const empty = made.bb.storage.database();
  empty.close();
  copyFileSync(join(out, "data.db"), empty.name);
  return made;
};
{
  const { bb, harness } = copy(createFakePluginHost({ pluginId: "code-review-workspace", dataDir: mkdtempSync(join(tmpdir(), "fixture-1.8.0-")) }));
  const store = queueStore(createStore(bb));
  await storeChecks("sqlite", store, sqliteSql(bb.storage.database()));
  await store.dispose();
  await harness.dispose();
}
{
  // The plugin opens each review, and asks a folder's review for changes and a rebuild, as its page does.
  const { bb, harness } = copy(createFakePluginHost({ pluginId: "code-review-workspace", dataDir: mkdtempSync(join(tmpdir(), "fixture-1.8.0-")) }));
  const stored = (k: string) => JSON.parse((bb.storage.database().prepare(`SELECT state FROM review_lifecycle WHERE target_key=?`).get(k) as { state: string }).state) as Record<string, unknown>;
  const lifecycles = Object.fromEntries([keys.feature, keys.own, keys.teammate].map((k) => [k, stored(k)]));
  await plugin(bb);
  const rpc = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<Record<string, unknown>>;
  const errors: Record<string, string> = {};
  const opened: Record<string, Record<string, unknown>> = {};
  for (const k of [keys.feature, keys.own, keys.teammate]) {
    try { opened[k] = await rpc("getReviewBundle", { targetKey: k }); } catch (error) { errors[`getReviewBundle ${k}`] = String(error); }
  }
  const featureOpened = opened[keys.feature];
  check("plugin", "every review opens", Object.keys(errors).length === 0 && Object.values(opened).every((bundle) => !!bundle.review), errors);
  check("plugin", "the folder's review opens on its last snapshot", typeof featureOpened?.patch === "string" && sha256(featureOpened.patch as string) === keys.featurePatch,
    { patchSha256: typeof featureOpened?.patch === "string" ? sha256(featureOpened.patch as string) : null, expected: keys.featurePatch });
  const answers: Record<string, unknown> = {};
  for (const method of ["checkForUpdates", "rereview", "startTrackedReview"]) {
    try { answers[method] = await rpc(method, { targetKey: keys.feature }); } catch (error) { answers[method] = { threw: String(error) }; }
  }
  check("plugin", "a folder's review runs no git (open, check for updates, rebuild)", ran("git").length === 0, { git: ran("git"), answers });
  const sentRead = (bundle: Record<string, unknown> | undefined) => (bundle?.review as Record<string, unknown> | undefined)?.sent;
  check("plugin", "sent reads as 1.8.0 stored it", [keys.feature, keys.own].every((k) => json(sentRead(opened[k])) === json(lifecycles[k]!.sent)),
    Object.fromEntries([keys.feature, keys.own].map((k) => [k, { read: sentRead(opened[k]), stored: lifecycles[k]!.sent }])));
  const listed = (await rpc("listReviews", null)).reviews as Array<Record<string, unknown>>;
  check("plugin", "listReviews lists every review, with sent as stored", [keys.feature, keys.own, keys.teammate].every((k) => listed.some((r) => r.targetKey === k))
    && [keys.feature, keys.own].every((k) => json(listed.find((r) => r.targetKey === k)?.sent) === json(lifecycles[k]!.sent)));
  // Whatever the plugin wrote while it ran, 1.8.0's keys are as they were.
  const newKeys = ["feature", "mainThread", "implementers", "sends", "threadSends", "readyToApprove", "letPush", "includeHidden", "flaggedSeen", "activity", "push", "notPushedSeen", "remoteHead", "keptBranches", "prConversation", "fixes", "headFork"];
  const changed = [keys.feature, keys.own, keys.teammate].flatMap((k) => newKeys.filter((key) => json(stored(k)[key]) !== json(lifecycles[k]![key])).map((key) => `${k}.${key}`));
  check("plugin", "1.8.0's lifecycle keys are unchanged after the plugin ran", changed.length === 0, changed);

  // 1.7.0's panel: an edit sends the comment's own fields; Keep pre-existing apart sends the whole comment back.
  const featureComment = (line: number) => (keys.comments[keys.feature].find((c) => c.file === "api.ts" && c.line === line))!;
  const draftOf = async (k: string) => (await rpc("getDraft", { targetKey: k })).draft as Draft;
  // The revision the page last read, which a save or Submit names.
  const revisionOf = async (k: string) => (await rpc("getReviewBundle", { targetKey: k })).revision as string;
  const c1 = featureComment(1);
  let editError: string | null = null;
  try { await rpc("saveDraftComment", { targetKey: keys.feature, revision: await revisionOf(keys.feature), replaces: (await draftOf(keys.feature)).comments.find((c) => c.line === 1)!.body, comment: { file: c1.file, line: c1.line, side: c1.side, body: "Edited in 1.7.0." } }); } catch (error) { editError = String(error); }
  const afterEdit = (await draftOf(keys.feature)).comments;
  const tracking = (c: object) => Object.keys(c).filter((key) => ["id", "state", "sendN", "claim", "editedBy"].includes(key));
  check("plugin", "a comment 1.7.0's panel edits loses its id and state; the others keep theirs", !editError && tracking(afterEdit.find((c) => c.line === 1 && c.file === "api.ts")!).length === 0
    && afterEdit.filter((c) => c.id && c.id !== c1.id).length === keys.comments[keys.feature].filter((c) => c.id && c.id !== c1.id).length, { editError, afterEdit });
  const markPreExisting = async (file: string, line: number) => {
    const { introduced: _introduced, ...rest } = (await draftOf(keys.feature)).comments.find((c) => c.file === file && c.line === line)!;
    try {
      await rpc("saveDraftComment", { targetKey: keys.feature, revision: await revisionOf(keys.feature), replaces: rest.body, comment: { ...rest, introduced: false } });
      return null;
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  };
  const untracked = await markPreExisting("util.ts", 1), tracked = await markPreExisting("api.ts", 2);
  check("plugin", "Pre-existing, which sends the whole comment back, works on a comment 1.8.0 tracked as on one it didn't", !tracked && !untracked, { tracked, untracked });

  // Submit, as the page sends it: the comments it shows, every field of theirs. What gh got is what GitHub would post.
  const submitted: Record<string, unknown> = {};
  for (const k of [keys.own, keys.teammate]) {
    const draft = await draftOf(k);
    for (const file of readdirSync(standIns).filter((name) => name.startsWith("posts-"))) rmSync(join(standIns, file));
    const result = await rpc("submitReview", { targetKey: k, revision: await revisionOf(k), account: "casey", comments: draft.comments, body: draft.body, verdict: draft.verdict });
    const posted = readdirSync(standIns).filter((name) => name.startsWith("posts-")).map((name) => JSON.parse(readFileSync(join(standIns, name), "utf8")) as { comments: Array<{ path: string; line: number; side: string }> });
    submitted[k] = { result, posted };
    const settled = keys.comments[k].filter((c) => c.state && c.state !== "open");
    const at = posted[0]?.comments.map((c) => `${c.path}:${c.line}:${c.side}`) ?? [];
    check("plugin", `${k}: Submit posts every comment in the draft, the ${[...new Set(settled.map((c) => c.state))].join(", ")} ones too`,
      result.ok === true && posted.length === 1 && at.length === keys.comments[k].length && keys.comments[k].every((c) => at.includes(`${c.file}:${c.line}:${c.side}`)), { result, at });
  }
  writeFileSync(join(out, "plugin-1.7.0.json"), formatDump({ answers, submitted, gh: ran("gh"), git: ran("git") }));
  await harness.dispose();
}

if (testPgUrl) {
  const pg = pgSql(testPgOptions(SCHEMA));
  const store = queueStore(storeOn(pg));
  const pgReads = formatDump(await dumpStoreReads(store, entities));
  writeFileSync(join(out, "reads-1.7.0-postgres.json"), pgReads);
  check("postgres", "every Store read of 1.8.0's data, with no error", throwsIn(pgReads).length === 0, throwsIn(pgReads));
  await storeChecks("postgres", store, pg);
  await store.dispose();
  await pg.end();
}

writeFileSync(join(out, "checks-1.7.0.json"), formatDump(results));
rmSync(standIns, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
