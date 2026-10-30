/**
 * The reverse of src/data-1.8.1.test.ts: a database 1.9.0 wrote, with every kind of data 1.9.0 adds, read with 1.8.1's
 * code, as a rollback to 1.8.1 would. A folder's review that became PR #31's, after following its branch's rename, with
 * comments on lines only in its folder (LOCAL), Not pushed yet's diff, its notice, and its agent's note; the PR's own
 * review merged into it, left archived and pointing at it; a folder's review offering to merge with its PR's review; and
 * one holding an older PR, its Push and open PR under way.
 *
 * `npx vite-node scripts/fixture-1.9.0.ts write <out dir>`, from this checkout's root, writes data.db, a consistent
 * snapshot, and keys.json, what the reader checks it against. With CRW_TEST_PG_URL naming a throwaway Postgres
 * (scripts/test-postgres.sh), it writes the same reviews to its schema crw_fixture_190 too.
 *
 * `npx vite-node scripts/fixture-1.9.0.ts read <out dir>`, with this file copied into a v1.8.1 checkout, as
 * `git archive v1.8.1` gives it, after npm ci, from that checkout's root: 1.8.1's Store reads of data.db (and, with
 * CRW_TEST_PG_URL, of the schema), what each draft would post, what 1.8.1's own writes and prune keep, and the plugin
 * opening each review and submitting the converted one with a stand-in gh and git first on PATH, which log every call.
 * It writes what it read beside data.db, prints a line per check, and exits 1 if any fails. docs/fixture-1.9.0.md has
 * the whole run.
 */
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore, storeOn } from "../src/store";
import { queueStore, type AsyncStore } from "../src/store-queue";
import { toGithubReviewPayload, type CommentLocation, type Draft } from "../src/draft";
import { prReviewKey, targetKey } from "../src/targets";
import { pruneDiffs } from "../src/feedback-view";
import { NOT_PUSHED } from "../lib/push";
import { pgSql } from "../src/db/pg";
import { sqliteSql, type Sql } from "../src/db/sql";
import { testPgOptions, testPgUrl } from "../src/db/pg-test.test-support";
import { dumpDatabase, dumpStoreReads, formatDump, storeEntities } from "./store-reads";

const [mode, out] = process.argv.slice(2);
if (mode !== "write" && mode !== "read" || !out) {
  process.stderr.write("Usage: npx vite-node scripts/fixture-1.9.0.ts write|read <out dir>\n");
  process.exit(2);
}

const SCHEMA = "crw_fixture_190";
const AT = 1_794_000_000_000;
const HEAD = "d4e5f60718293a4b5c6d7e8f90123456789abcde";
// The PR's diff at its head.
const PATCH = [
  "diff --git a/api.ts b/api.ts", "--- a/api.ts", "+++ b/api.ts", "@@ -1,3 +1,4 @@", "-const tries = 3;", "+const tries = 5;", "+retry(upload);", " send();", " done();",
  "diff --git a/util.ts b/util.ts", "--- a/util.ts", "+++ b/util.ts", "@@ -1,2 +1,2 @@", "-export const wait = 10;", "+export const wait = 100;", " export {};", "",
].join("\n");
// Not pushed yet: what the folder has that the PR's head doesn't, a line of a file in the PR and a file that isn't.
const AHEAD = [
  "diff --git a/api.ts b/api.ts", "--- a/api.ts", "+++ b/api.ts", "@@ -1,4 +1,4 @@", " const tries = 5;", "-retry(upload);", "+retry(upload, tries);", " send();", " done();",
  "diff --git a/retry.ts b/retry.ts", "new file mode 100644", "--- /dev/null", "+++ b/retry.ts", "@@ -0,0 +1,1 @@", "+export const retry = () => {};", "",
].join("\n");

/** The reviews, and the comments on lines only in the folder, for the reader. */
interface Keys {
  converted: string; tombstone: string; offering: string; offeredPr: string; pending: string;
  local: Array<CommentLocation & { body: string }>;
  /** The lifecycle keys 1.9.0 adds, by review. */
  added: Record<string, string[]>;
}

const ADDED = ["became", "prOffer", "prPending", "mergedInto", "mergedAt", "mergedFrom", "agentPrNote", "followed", "formerBranches"];

/** The reviews as 1.9.0 writes them, through its store. */
async function writeReviews(store: AsyncStore): Promise<Keys> {
  // 1.8.1 has none of these, so the reader never loads them.
  const { featureKey } = await import("../src/targets");
  const { sendKey } = await import("../lib/send-baseline");
  const { mergeIn } = await import("../src/merge");
  const at = (file: string, line: number, side: CommentLocation["side"] = "RIGHT"): CommentLocation => ({ file, line, side });
  const machine = { hostId: "host_maxbook", machine: "MaxBook", baseRef: "main", repo: "acme/web", changedFiles: null };
  const url = (n: number) => `https://github.com/acme/web/pull/${n}`;

  // PR #31's own review, found on GitHub before the folder's became the PR's: a comment of yours, and its agent's chat.
  const tombstone = targetKey({ kind: "pr", repo: "acme/web", number: 31 });
  await store.saveReview({
    targetKey: tombstone, kind: "pr", number: 31, repo: "acme/web", title: "Retry uploads", author: "casey", base: "main", head: "casey/retries",
    gitRef: "main...casey/retries", url: url(31), status: "ready", createdAt: AT, projectId: "p1", headSha: HEAD,
  });
  await store.savePatch(tombstone, PATCH);
  await store.saveSnapshot(tombstone, HEAD, PATCH);
  await store.upsertDraftComment(tombstone, { ...at("api.ts", 3), body: "Log the failure." });
  await store.setAssistantThread(tombstone, "thr_agent31");
  await store.setLifecycle(tombstone, { prState: "OPEN", ownPr: true, reviewer: "casey", latestHeadSha: HEAD, watchingSince: AT });

  // The folder's review, its key from its first branch, which it followed when renamed; now PR #31's, pushed under another
  // name, its comments on the PR's lines and on Not pushed yet's.
  const converted = featureKey("env_conv", "casey/retry");
  await store.saveReview({
    targetKey: converted, kind: "pr", number: 31, repo: "acme/web", title: "Retry uploads", author: "casey", base: "main", head: "casey/retries",
    gitRef: "main...casey/retries", url: url(31), status: "ready", createdAt: AT + 10, projectId: "p1", headSha: HEAD,
  });
  await store.savePatch(converted, PATCH);
  await store.saveSnapshot(converted, HEAD, PATCH);
  await store.saveSnapshot(converted, NOT_PUSHED, AHEAD);
  await store.upsertDraftComment(converted, { ...at("api.ts", 1), severity: "should-fix", body: "Cap the retries." });
  await store.trackComments(converted, [{ at: at("api.ts", 1), id: "c1", state: "sent", sendN: 1 }]);
  await store.saveSnapshot(converted, sendKey(1), PATCH);
  const local = [{ ...at("api.ts", 2, "LOCAL"), body: "Pass the tries along." }, { ...at("retry.ts", 1, "LOCAL"), body: "Export its type." }];
  for (const comment of local) await store.upsertDraftComment(converted, comment);
  await store.setAssistantThread(converted, "thr_agent_conv");
  const main = { threadId: "thr_conv", environmentId: "env_conv", origin: "adopted" as const, since: AT + 10 };
  await store.setLifecycle(converted, {
    feature: { ...machine, environmentId: "env_conv", path: "/Users/casey/src/web", branch: "casey/retries-2", remoteBranch: "casey/retries", headSha: "5555555555555555555555555555555555555555" },
    mainThread: main, sourceThreadId: "thr_conv", sourceThreadAt: AT + 10, ownPr: true, prState: "OPEN", reviewer: "casey", latestHeadSha: HEAD, watchingSince: AT + 20,
    sends: [{ n: 1, at: AT + 15, threadId: "thr_conv", ids: ["c1"] }],
    followed: { from: "casey/retry", branch: "casey/retries-2", at: AT + 12 }, formerBranches: ["casey/retry"],
    became: { at: AT + 20, number: 31, url: url(31), from: "web:casey/retry", carried: 3, local: 2, outside: 0 },
    agentPrNote: { number: 31, url: url(31), from: "web:casey/retry" },
  });
  // The PR's own review goes into it: its comment comes along, its agent kept apart, and it's left archived, pointing here.
  await store.exclusive((tx) => mergeIn(tx, tombstone, converted));

  // A folder's review whose PR's review has your notes: it offers to merge them.
  const offeredPr = targetKey({ kind: "pr", repo: "acme/web", number: 32 });
  await store.saveReview({ targetKey: offeredPr, kind: "pr", number: 32, repo: "acme/web", title: "Retry downloads", author: "casey", url: url(32), status: "tracked", createdAt: AT + 30, projectId: "p1" });
  await store.saveReviewerNotes(offeredPr, "Mine: check the timeouts.", 0);
  const offering = featureKey("env_32", "casey/downloads");
  await store.saveReview({ targetKey: offering, kind: "ref", gitRef: "casey/downloads", title: "Retry downloads", status: "ready", createdAt: AT + 31, projectId: "p1" });
  await store.savePatch(offering, PATCH);
  await store.setLifecycle(offering, {
    feature: { ...machine, environmentId: "env_32", path: "/Users/casey/src/web-32", branch: "casey/downloads" },
    prOffer: { key: offeredPr, number: 32, url: url(32), moves: { comments: 0, summary: false, sends: 0 } },
  });

  // A folder's review holding a PR opened before it, its Push and open PR under way.
  const pending = featureKey("env_33", "casey/metrics");
  await store.saveReview({ targetKey: pending, kind: "ref", gitRef: "casey/metrics", title: "Upload metrics", status: "ready", createdAt: AT + 40, projectId: "p1" });
  await store.savePatch(pending, PATCH);
  await store.setLifecycle(pending, {
    feature: { ...machine, environmentId: "env_33", path: "/Users/casey/src/web-33", branch: "casey/metrics" },
    mainThread: { threadId: "thr_33", environmentId: "env_33", origin: "adopted", since: AT + 40 },
    prPending: { number: 33, url: url(33), why: "older", at: AT + 41 },
    push: { state: "pushing", at: AT + 42, threadId: "thr_33", repo: "acme/web", head: "casey/metrics", thenOpenPr: true },
  });

  const added: Keys["added"] = {};
  for (const review of await store.listReviews()) added[review.targetKey] = ADDED.filter((key) => (review as unknown as Record<string, unknown>)[key] != null);
  return { converted, tombstone, offering, offeredPr, pending, local, added };
}

if (mode === "write") {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = queueStore(createStore(bb));
  const keys = await writeReviews(store);
  await store.dispose();
  rmSync(join(out, "data.db"), { force: true });
  bb.storage.database().prepare(`VACUUM INTO ?`).run(join(out, "data.db"));
  writeFileSync(join(out, "keys.json"), formatDump(keys));
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

// read: 1.8.1's code.
const keys = JSON.parse(readFileSync(join(out, "keys.json"), "utf8")) as Keys;
const reviews = [keys.converted, keys.tombstone, keys.offering, keys.offeredPr, keys.pending];
const results: Array<{ backend: string; check: string; ok: boolean; detail?: unknown }> = [];
const check = (backend: string, name: string, ok: boolean, detail?: unknown) => {
  results.push({ backend, check: name, ok, ...detail === undefined ? {} : { detail } });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} [${backend}] ${name}${!ok && detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}\n`);
};
const json = (value: unknown) => JSON.stringify(value);
const throwsIn = (reads: string) => [...reads.matchAll(/"\$throws": "([^"]*)"/g)].map((m) => m[1]);
type Posted = { comments: Array<{ path: string; line: number; side: string; body: string }> };
/** Each comment on a line only in the folder, as a review posted it: not at all, or with its side, LOCAL, never as a line of the PR's diff. */
const localAsPosted = (posted: Posted) => keys.local.map((c) => ({ at: `${c.file}:${c.line}`, sides: posted.comments.filter((p) => p.body.includes(c.body)).map((p) => p.side) }));
const neverOnALine = (posted: Posted) => localAsPosted(posted).every(({ sides }) => sides.every((side) => side !== "RIGHT" && side !== "LEFT"));

// gh and git that log every call, first on PATH, so nothing reaches GitHub and any git the plugin runs shows. git
// always fails; gh answers only what Submit asks, as @casey, and keeps the review it would post.
const standIns = mkdtempSync(join(tmpdir(), "fixture-1.9.0-bin-"));
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

/** The Store checks, on either backend: the tombstone, what each draft posts, and what 1.8.1's writes and prune keep. */
async function storeChecks(backend: string, store: AsyncStore, sql: Sql) {
  const tombstone = await store.getReview(keys.tombstone);
  check(backend, "the review merged away reads as an archived PR review", tombstone?.kind === "pr" && typeof tombstone.archivedAt === "number"
    && (await store.listReviews()).some((r) => r.targetKey === keys.tombstone && r.archivedAt), tombstone);
  const prKey = await prReviewKey(store, { repo: "acme/web", number: 31 });
  check(backend, `1.8.1's prReviewKey for PR #31 gives the review merged away (${prKey})`, prKey === keys.tombstone, { prKey });

  const payloads: Record<string, unknown> = {};
  for (const k of reviews) {
    const draft = await store.getDraft(k);
    payloads[k] = { plain: toGithubReviewPayload(draft, false, false), own: toGithubReviewPayload(draft, false, true) };
  }
  writeFileSync(join(out, `payloads-1.8.1-${backend}.json`), formatDump(payloads));
  const { own } = payloads[keys.converted] as { own: Posted };
  check(backend, "the converted review's draft posts a comment on a line only in the folder as LOCAL, never on a line of the PR's diff", neverOnALine(own), localAsPosted(own));

  // A write of 1.8.1's own keeps every lifecycle key it doesn't know.
  const lifecycle = async (k: string) => JSON.parse((await sql.get<{ state: string }>(`SELECT state FROM review_lifecycle WHERE target_key=?`, [k]))?.state ?? "{}") as Record<string, unknown>;
  for (const k of reviews) {
    const before = await lifecycle(k);
    await store.setLifecycle(k, { pinnedAt: AT + 999 });
    const after = await lifecycle(k);
    check(backend, `${k}: 1.8.1's setLifecycle keeps 1.9.0's keys (${keys.added[k]!.join(", ") || "none"})`, json(after) === json({ ...before, pinnedAt: AT + 999 }), { before, after });
  }

  // 1.8.1's prune keeps the heads it knows, so it drops Not pushed yet's diff, and the comments on it keep their code.
  await pruneDiffs(store, (await store.getReview(keys.converted))!);
  const left = await store.getSnapshot(keys.converted, NOT_PUSHED);
  const code = await sql.all<{ side: string; code: string }>(`SELECT side, code FROM draft_comment_revisions WHERE target_key=? AND side='LOCAL' ORDER BY file`, [keys.converted]);
  check(backend, "1.8.1's prune drops the not-pushed snapshot, and the LOCAL comments keep their code", left === null && code.length === keys.local.length, { left: left !== null, code });
}

const db = new Database(join(out, "data.db"), { readonly: true, fileMustExist: true });
const entities = storeEntities(db);
db.close();

// SQLite: 1.8.1's reads dump, then the Store checks and the plugin, each on a copy.
const { reads } = await dumpDatabase(join(out, "data.db"));
writeFileSync(join(out, "reads-1.8.1-sqlite.json"), reads);
check("sqlite", "every Store read of 1.9.0's data, with no error", throwsIn(reads).length === 0, throwsIn(reads));

const copy = (made: ReturnType<typeof createFakePluginHost>) => {
  const empty = made.bb.storage.database();
  empty.close();
  copyFileSync(join(out, "data.db"), empty.name);
  return made;
};
{
  const { bb, harness } = copy(createFakePluginHost({ pluginId: "code-review-workspace", dataDir: mkdtempSync(join(tmpdir(), "fixture-1.9.0-")) }));
  const store = queueStore(createStore(bb));
  await storeChecks("sqlite", store, sqliteSql(bb.storage.database()));
  await store.dispose();
  await harness.dispose();
}
{
  // The plugin opens each review, as its page does, and submits the converted one.
  const { bb, harness } = copy(createFakePluginHost({ pluginId: "code-review-workspace", dataDir: mkdtempSync(join(tmpdir(), "fixture-1.9.0-")) }));
  const stored = (k: string) => JSON.parse((bb.storage.database().prepare(`SELECT state FROM review_lifecycle WHERE target_key=?`).get(k) as { state: string } | undefined)?.state ?? "{}") as Record<string, unknown>;
  const lifecycles = Object.fromEntries(reviews.map((k) => [k, stored(k)]));
  await plugin(bb);
  const rpc = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<Record<string, unknown>>;
  const attempt = async (method: string, input: unknown) => {
    try { return await rpc(method, input); } catch (error) { return { threw: error instanceof Error ? error.message : String(error) }; }
  };
  const opened = Object.fromEntries(await Promise.all(reviews.map(async (k) => [k, await attempt("getReviewBundle", { targetKey: k })] as const)));
  check("plugin", "every review opens", Object.values(opened).every((bundle) => !!bundle.review), Object.fromEntries(Object.entries(opened).filter(([, bundle]) => !bundle.review)));
  const tombstone = opened[keys.tombstone]!.review as Record<string, unknown> | undefined;
  check("plugin", "the review merged away opens as an archived PR review, with no comments", tombstone?.kind === "pr" && typeof tombstone.archivedAt === "number"
    && (await rpc("getDraft", { targetKey: keys.tombstone }) as { draft: Draft }).draft.comments.length === 0, tombstone);
  // 1.8.1 calls a LOCAL comment stale, on a diff not the review's, and its contract takes a stale comment only on LEFT or
  // RIGHT: the converted review's draft doesn't load. The others do.
  const drafts = Object.fromEntries(await Promise.all(reviews.map(async (k) => [k, await attempt("getDraft", { targetKey: k })] as const)));
  const failed = Object.entries(drafts).filter(([, read]) => "threw" in read);
  check("plugin", "every review's draft loads but the converted one's, which 1.8.1's contract refuses for its LOCAL comments",
    json(failed) === json([[keys.converted, { threw: "rpc output validation failed" }]]), Object.fromEntries(failed));
  const listed = await attempt("listReviews", null);
  check("plugin", "listReviews lists every review, the one merged away archived",
    reviews.every((k) => (listed.reviews as Array<Record<string, unknown>> | undefined)?.some((r) => r.targetKey === k && (k !== keys.tombstone || r.archivedAt))), listed);

  // Submit on the converted review, as its page would send it: the draft's comments, the open ones posting. Then the
  // same past every warning, then with only the comments 1.8.1's contract takes. What gh got is what GitHub would get.
  const submitted: Record<string, unknown> = {};
  const draft = (await bb.storage.database().prepare(`SELECT comments, body, verdict FROM drafts WHERE target_key=?`).get(keys.converted)) as { comments: string; body: string; verdict: string };
  const comments = JSON.parse(draft.comments) as Array<Record<string, unknown>>;
  const shown = comments.map(({ file, line, side, startLine, startSide, severity, introduced, body }) => ({ file, line, side, startLine, startSide, severity, introduced, body }));
  const posting = comments.filter((c) => !c.state || c.state === "open").map(({ file, line, side }) => ({ file, line, side }));
  const revision = (opened[keys.converted]!.revision as string | undefined) ?? undefined;
  const submitWith = async (name: string, input: Record<string, unknown>) => {
    for (const file of readdirSync(standIns).filter((f) => f.startsWith("posts-"))) rmSync(join(standIns, file));
    const result = await attempt("submitReview", { targetKey: keys.converted, revision, account: "casey", body: draft.body, verdict: draft.verdict, ...input });
    const posted = readdirSync(standIns).filter((f) => f.startsWith("posts-")).map((f) => JSON.parse(readFileSync(join(standIns, f), "utf8")) as Posted);
    submitted[name] = { result, posted };
    return { result, posted };
  };
  const asShown = await submitWith("as shown", { comments: shown, posting });
  const anyway = await submitWith("anyway", { comments: shown, posting, force: true });
  const kept = shown.filter((c) => c.side !== "LOCAL");
  const contract = await submitWith("without LOCAL", { comments: kept, posting: posting.filter((c) => c.side !== "LOCAL"), force: true });
  // Past what posts, nothing does: 1.8.1's contract refuses a LOCAL comment, and without them the draft differs.
  check("plugin", "Submit posts nothing: refused with the LOCAL comments, as the page would send them or past its warnings, and Draft changed without them",
    [asShown, anyway].every(({ result }) => result.threw === "rpc input validation failed") && contract.result.ok === false && /^Draft changed/.test(String(contract.result.error))
      && [asShown, anyway, contract].every(({ posted }) => posted.length === 0 && posted.every(neverOnALine)) && !ran("gh").some((call) => call.includes("POST")), submitted);
  writeFileSync(join(out, "plugin-1.8.1.json"), formatDump({ opened: Object.fromEntries(Object.entries(opened).map(([k, b]) => [k, b.review ?? b])), drafts, submitted, gh: ran("gh"), git: ran("git") }));

  // Whatever the plugin wrote while it ran, 1.9.0's keys are as they were.
  const changed = reviews.flatMap((k) => [...ADDED, "feature", "push"].filter((key) => json(stored(k)[key]) !== json(lifecycles[k]![key])).map((key) => `${k}.${key}`));
  check("plugin", "1.9.0's lifecycle keys are unchanged after the plugin ran", changed.length === 0, Object.fromEntries(changed.map((at) => {
    const [k, key] = at.split(".") as [string, string];
    return [at, { before: lifecycles[k]![key], after: stored(k)[key] }];
  })));
  await harness.dispose();
}

if (testPgUrl) {
  const pg = pgSql(testPgOptions(SCHEMA));
  const store = queueStore(storeOn(pg));
  const pgReads = formatDump(await dumpStoreReads(store, entities));
  writeFileSync(join(out, "reads-1.8.1-postgres.json"), pgReads);
  check("postgres", "every Store read of 1.9.0's data, with no error", throwsIn(pgReads).length === 0, throwsIn(pgReads));
  await storeChecks("postgres", store, pg);
  await store.dispose();
  await pg.end();
}

writeFileSync(join(out, "checks-1.8.1.json"), formatDump(results));
rmSync(standIns, { recursive: true, force: true });
const failures = results.filter((r) => !r.ok).length;
process.stdout.write(`${results.length - failures} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
