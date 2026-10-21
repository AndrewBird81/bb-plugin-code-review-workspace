// The Store on SQLite and on Postgres, given the same seeded random sequence of calls, answers each call the same and,
// after each one, every read the same; at the end their tables hold the same rows.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { canonical, dumpStoreReads, type StoreEntities } from "../scripts/store-reads";
import { pgTestSql, testPgUrl } from "./db/pg-test.test-support";
import { sqliteSql, type Sql } from "./db/sql";
import type { CommentLocation, DraftComment } from "./draft";
import type { FeedbackThread } from "./github/types";
import { defaultPreferences } from "./preferences";
import { createStore, storeOn, type ReviewLifecycle, type ReviewMeta } from "./store";
import { queueStore, type AsyncStore } from "./store-queue";
import { rng, type Rng } from "./fuzz-gen.test-support";
import { REMOVAL_REASONS } from "../lib/removal-reasons";

// createStore is SQLite's here, whatever the test backend.
vi.unmock("./store");
// beginGeneration's ids, the same on both backends.
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const KEYS = ["pr-1", "pr-2", "ref-1"];
const HEADS = ["sha1", "sha2", "sha3"];
const THREADS = ["assistant-1", "assistant-2", "writer-1", "writer-2", "legacy-1", "t1", "t2"];
// Names whose order differs between byte order and a locale's, and text that needs care in SQL.
const FILES = ["a.ts", "B.ts", "src/old.ts", "src/new.ts", "ä.ts", "_x.ts"];
const TEXTS = ["", "Why?", "it's \"quoted\" ? $1 -- not a comment", "naïve café ✓ 🚀", "line one\nline two\r\n\ttabbed", "x".repeat(3000), "SELECT 1; DROP TABLE reviews"];
const TIMES = [0, 1, 1792524726294, Number.MAX_SAFE_INTEGER];
const SIDES = ["LEFT", "RIGHT"] as const;
const LOCATIONS: CommentLocation[] = [{ file: "", line: 0, side: "RIGHT" }, ...FILES.flatMap((file) => [1, 2, 3].flatMap((line) => SIDES.map((side) => ({ file, line, side }))))];

const filePatch = (file: string, lines: string[]) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,${lines.length} +1,${lines.length + 1} @@`, ...lines.map((line) => ` ${line}`), "+added", ""].join("\n");
const PATCHES = [
  "",
  filePatch("a.ts", ["one", "two", "three"]),
  filePatch("a.ts", ["one", "two", "three"]) + filePatch("B.ts", ["x", "y"]) + filePatch("ä.ts", ["ü"]),
  filePatch("src/old.ts", ["old one", "old two"]),
  "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 90%\nrename from src/old.ts\nrename to src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1,2 +1,2 @@\n old one\n-old two\n+new two\n",
];

interface Made { generations: Map<string, string[]> }

interface Call { name: string; run(store: AsyncStore): Promise<unknown> }

function location(r: Rng): CommentLocation {
  return r.pick(LOCATIONS);
}

function comment(r: Rng): DraftComment {
  const at = location(r);
  return {
    ...at,
    body: r.pick(TEXTS),
    ...(r.bool(0.3) && at.line > 1 ? { startLine: at.line - 1 } : {}),
    ...(r.bool(0.3) ? { startSide: r.pick(SIDES) } : {}),
    ...(r.bool(0.5) ? { author: "agent" as const } : {}),
    ...(r.bool(0.5) ? { severity: r.pick(["blocking", "should-fix", "question", "nit"] as const) } : {}),
    ...(r.bool(0.3) ? { evidence: r.pick(TEXTS) } : {}),
    ...(r.bool(0.2) ? { introduced: false as const } : {}),
    ...(r.bool(0.2) ? { chapterId: `c${r.int(1, 3)}` } : {}),
  };
}

function lifecycle(r: Rng): ReviewLifecycle {
  return r.pick<ReviewLifecycle>([
    { prState: r.pick(["OPEN", "CLOSED", "MERGED"] as const), latestHeadSha: r.pick(HEADS) },
    { userArchivedAt: r.pick([null, ...TIMES]), name: r.pick([null, ...TEXTS]) },
    { pinnedAt: r.pick([null, ...TIMES]), snoozedUntil: r.pick([null, ...TIMES]) },
    { signals: null, assessment: null, reviewBodies: [{ state: "COMMENTED", at: r.pick(TIMES), body: r.pick(TEXTS) }] },
    { commentAsks: [{ ...location(r), ask: { threadId: r.pick([null, ...THREADS]), state: "queued", queuedMessageId: "m1", at: r.pick(TIMES) } }] },
    { prSize: { additions: r.int(0, 9), deletions: r.int(0, 9), files: r.int(0, 3) }, ownPr: r.pick([null, true, false]) },
  ]);
}

function feedbackThread(r: Rng, id: string): FeedbackThread {
  const replies = r.bool(0.5) ? [{ author: "ann", bot: false, mine: false, body: r.pick(TEXTS), createdAt: r.pick(TIMES) }] : [];
  return {
    id, commentId: r.int(1, 99), reviewId: r.pick([null, "rev-1"]), path: r.pick([null, ...FILES]), line: r.pick([null, 1, 2]), originalLine: r.pick([null, 1]),
    startLine: null, side: r.pick([null, ...SIDES]), subjectType: r.pick(["LINE", "FILE"] as const), body: r.pick(TEXTS), createdAt: r.pick(TIMES),
    isResolved: r.bool(), resolvedBy: r.pick([null, "ann"]), isOutdated: r.bool(), replies, status: r.pick(["resolved", "question", "answered", "open"] as const),
    replyAt: r.pick([null, ...TIMES]),
  };
}

/** One random Store call, its arguments chosen now, so each backend gets the same call. */
function randomCall(r: Rng, made: Made): Call {
  const k = r.pick(KEYS);
  const at = location(r);
  const call = (name: string, run: Call["run"]): Call => ({ name: `${name} ${k}`, run });
  switch (r.int(0, 50)) {
    case 0: case 1: {
      const meta: ReviewMeta = {
        targetKey: k, kind: k.startsWith("pr") ? "pr" : "ref", status: r.pick(["generating", "ready", "error", "tracked"] as const), createdAt: r.pick(TIMES),
        ...(r.bool() ? { number: r.int(1, 999), repo: "acme/web", title: r.pick(TEXTS), author: "ann", url: "https://example.test/1" } : { gitRef: "main", cwd: "/repo" }),
        ...(r.bool() ? { headSha: r.pick(HEADS), base: "main", head: "feature", projectId: "p1" } : {}),
      };
      return call("saveReview", (s) => s.saveReview(meta));
    }
    case 2: { const status = r.pick(["generating", "ready", "error", "tracked"] as const); return call("setStatus", (s) => s.setStatus(k, status)); }
    case 3: case 4: { const state = lifecycle(r); return call("setLifecycle", (s) => s.setLifecycle(k, state)); }
    case 5: { const text = r.pick([null, ...TEXTS]); return call("setReviewContext", (s) => s.setReviewContext(k, text)); }
    case 6: return call("deleteReview", (s) => s.deleteReview(k));
    case 7: case 8: { const patch = r.pick(PATCHES); return call("savePatch", (s) => s.savePatch(k, patch)); }
    case 9: return call("dropPatch", (s) => s.dropPatch(k));
    case 10: {
      const guide = { title: r.pick(TEXTS), intent: "I", unplacedFiles: [], sections: [{ id: "s", title: "S", overview: "o", risk: "low", diffs: [{ file: r.pick(FILES), summary: "s" }] }], hotspots: [] };
      return call("saveGuide", (s) => s.saveGuide(k, guide as never));
    }
    case 11: return call("beginGeneration", async (s) => {
      const id = await s.beginGeneration(k);
      made.generations.set(k, [...new Set([...made.generations.get(k) ?? [], id])]);
      return id;
    });
    case 12: return call("backupGuide", (s) => s.backupGuide(k));
    case 13: return call("restoreGuide", (s) => s.restoreGuide(k));
    case 14: return call("dropGuideBackup", (s) => s.dropGuideBackup(k));
    case 15: {
      const worker = r.pick(THREADS);
      const pick = r.bool(0.8);
      return call("setGenerationWorker", (s) => s.setGenerationWorker(k, pick ? made.generations.get(k)?.at(-1) ?? "none" : "stale", worker));
    }
    case 16: return call("interruptGenerations", (s) => s.interruptGenerations());
    case 17: case 18: { const c = comment(r); return call("upsertDraftComment", (s) => s.upsertDraftComment(k, c)); }
    case 19: {
      const body = r.pick(TEXTS), severity = r.pick([undefined, null, "nit"] as const), evidence = r.pick([undefined, null, "read a.ts:1"]), introduced = r.pick([undefined, true, false]);
      return call("editDraftComment", (s) => s.editDraftComment(k, at, body, severity, evidence, introduced));
    }
    case 20: return call("deleteDraftComment", (s) => s.deleteDraftComment(k, at));
    case 21: {
      const verdict = r.pick(["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const), body = r.pick([undefined, ...TEXTS]);
      return call("setVerdict", (s) => s.setVerdict(k, verdict, body));
    }
    case 22: {
      const change = r.pick([{ body: r.pick(TEXTS), bodyAuthor: "agent" as const }, { suggestedVerdict: "APPROVE" as const, written: undefined }, { verdict: "COMMENT" as const, verdictChosen: true as const }]);
      return call("updateSummary", (s) => s.updateSummary(k, change));
    }
    case 23: return call("clearSubmittedDraft", async (s) => s.clearSubmittedDraft(await s.getDraft(k)));
    case 24: case 25: {
      const author = r.pick(["reviewer", "agent"] as const), body = r.pick(TEXTS), startLine = r.pick([undefined, 1]);
      return call("addDiscussionMessage", (s) => s.addDiscussionMessage(k, at, author, body, startLine));
    }
    case 26: {
      const kind = r.pick(["added", "edited", "removed"] as const);
      const change = r.pick([undefined, { body: r.pick(TEXTS), previous: null }, { body: "Edited", previous: { body: r.pick(TEXTS), author: "agent" as const, severity: "nit" as const } }]);
      return call("noteDiscussionChange", (s) => s.noteDiscussionChange(k, at, kind, change));
    }
    case 27: return call("noteDiscussionRestored", (s) => s.noteDiscussionRestored(k, at));
    case 28: return call("deleteDiscussion", (s) => s.deleteDiscussion(k, at));
    case 29: return call("clearDiscussions", (s) => s.clearDiscussions(k));
    case 30: return call("stopWaiting", (s) => s.stopWaiting(k));
    case 31: case 32: {
      const file = r.pick(FILES), hash = `hash-${r.int(1, 3)}`, viewedAt = r.pick([undefined, ...TIMES]);
      return call("setFileViewed", (s) => s.setFileViewed(k, file, hash, viewedAt));
    }
    case 33: { const file = r.pick(FILES); return call("unsetFileViewed", (s) => s.unsetFileViewed(k, file)); }
    case 34: return call(r.bool() ? "clearAgentThread" : "clearAgentMessages", r.bool() ? (s) => s.clearAgentThread(k) : (s) => s.clearAgentMessages(k));
    case 35: { const thread = r.pick(THREADS); return call("setAssistantThread", (s) => s.setAssistantThread(k, thread)); }
    case 36: return call("clearAssistantThread", (s) => s.clearAssistantThread(k));
    case 37: { const head = r.pick(HEADS), patch = r.pick(PATCHES); return call("saveSnapshot", (s) => s.saveSnapshot(k, head, patch)); }
    case 38: { const keep = HEADS.filter(() => r.bool()); return call("pruneSnapshots", (s) => s.pruneSnapshots(k, keep)); }
    case 39: {
      const threads = ["t1", "t2"].filter(() => r.bool(0.7)).map((id) => feedbackThread(r, id)), updated = r.pick([null, ...TIMES]);
      return call("saveFeedbackThreads", (s) => s.saveFeedbackThreads(k, threads, updated));
    }
    case 40: return call("clearFeedbackFetches", (s) => s.clearFeedbackFetches());
    case 41: {
      const head = r.pick(HEADS);
      const items = ["t1", "summary:1"].filter(() => r.bool(0.7)).map((id) => ({
        id, verdict: r.pick(["addressed", "partial", "not_addressed", "disputed", "unclear"] as const), evidence: r.pick(TEXTS), assessedAt: r.pick(TIMES),
        ...(r.bool() ? { file: r.pick(FILES), line: r.int(1, 3) } : {}),
      }));
      return call("saveAssessmentItems", (s) => s.saveAssessmentItems(k, head, items));
    }
    case 42: {
      const run = { headSha: r.pick(HEADS), summary: r.pick(TEXTS), suggestedVerdict: r.pick([null, "APPROVE", "COMMENT"] as const), suggestedBody: r.pick(TEXTS), assessedAt: r.pick(TIMES) };
      return call("saveAssessmentRun", (s) => s.saveAssessmentRun(k, run));
    }
    case 43: {
      const thread = r.pick(["t1", "t2"]), body = r.pick(TEXTS), author = r.pick(["agent", "reviewer"] as const);
      return r.bool(0.7) ? call("setReplyDraft", (s) => s.setReplyDraft(k, thread, body, author)) : call("deleteReplyDraft", (s) => s.deleteReplyDraft(k, thread));
    }
    case 44: return r.bool() ? call("ignoreDiscovery", (s) => s.ignoreDiscovery(k)) : call("unignoreDiscovery", (s) => s.unignoreDiscovery(k));
    case 45: {
      const placements = LOCATIONS.filter((l) => l.file && r.bool(0.1)).map((l) => ({ at: l, line: r.int(1, 4), ...(r.bool(0.3) ? { startLine: 1 } : {}) }));
      return call("rebaseDraftComments", (s) => s.rebaseDraftComments(k, placements));
    }
    case 46: {
      const kind = r.pick(["removed", "edited"] as const), code = r.pick([null, "const x = 1;"]), body = r.pick(TEXTS), removed = r.pick([null, ...TEXTS]);
      return call("noteAgentCommentChange", (s) => s.noteAgentCommentChange(k, { ...at, kind, code, body, removed }));
    }
    case 47: { const id = r.int(1, 6); return call("forgetAgentCommentChange", (s) => s.forgetAgentCommentChange(k, id)); }
    case 48: {
      const why = { reason: r.pick(REMOVAL_REASONS), ...(r.bool() ? { note: r.pick(TEXTS) } : {}) };
      return call("setRemovalReason", (s) => s.setRemovalReason(k, at, why));
    }
    case 49: {
      const moves = LOCATIONS.filter((l) => l.file && r.bool(0.1)).map((l) => ({ at: l, line: r.int(1, 4) }));
      return call("moveAgentCommentChanges", (s) => s.moveAgentCommentChanges(k, moves));
    }
    default: {
      if (r.bool(0.5)) {
        // Mostly at the saved revision; otherwise a stale one, which is refused.
        const text = r.pick(TEXTS), stale = r.bool(0.2);
        return r.bool()
          ? call("saveReviewerNotes", async (s) => s.saveReviewerNotes(k, text, (await s.getReviewerNotes(k)).revision - (stale ? 1 : 0)))
          : call("savePreferences", async (s) => s.savePreferences({ ...defaultPreferences, assistantInstructions: text.slice(0, 2000) }, (await s.getPreferences()).revision - (stale ? 1 : 0)));
      }
      const outcomes = FILES.filter(() => r.bool(0.3)).map((file) => ({ repo: "acme/web", file, outcome: r.pick(["kept", "edited", "removed"] as const), body: r.pick(TEXTS), edited: r.pick([null, "Edited"]) }));
      return call("recordAgentOutcomes", (s) => s.recordAgentOutcomes(k, outcomes));
    }
  }
}

type Settled = { value: unknown } | { error: string };

async function settle(run: () => Promise<unknown>): Promise<Settled> {
  try {
    return { value: canonical(await run()) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Each table's rows, as canonical JSON, sorted. */
async function tableRows(sql: Sql, tables: readonly string[]) {
  const rows: Record<string, string[]> = {};
  for (const table of tables) rows[table] = (await sql.all(`SELECT * FROM ${table}`)).map((row) => JSON.stringify(canonical(row))).sort();
  return rows;
}

const T0 = 1_800_000_000_000;
const STEPS = 120;

describe.skipIf(!testPgUrl)("the Store on SQLite and on Postgres (CRW_TEST_PG_URL)", () => {
  afterEach(() => { vi.useRealTimers(); });

  test.each([1, 2, 3, 4])("a seeded random sequence of calls answers, and reads after each, the same on both (seed %i)", async (seed) => {
    const r = rng(seed);
    const made: Made = { generations: new Map() };
    const sqliteHost = createFakePluginHost({ pluginId: "code-review-workspace" });
    const pgHost = createFakePluginHost({ pluginId: "code-review-workspace" });
    const backends = [
      { name: "sqlite", sql: sqliteSql(sqliteHost.bb.storage.database()), store: queueStore(createStore(sqliteHost.bb)) },
      { name: "postgres", sql: pgTestSql(pgHost.bb), store: queueStore(storeOn(pgTestSql(pgHost.bb))) },
    ];
    vi.useFakeTimers({ toFake: ["Date"] });
    // On each backend, the same time and the same ids.
    const same = async <T,>(step: number, run: (backend: typeof backends[number]) => Promise<T>) => {
      const results: T[] = [];
      for (const backend of backends) {
        let id = 0;
        vi.mocked(randomUUID).mockImplementation(() => `00000000-0000-4000-8000-${String(step * 100 + id++).padStart(12, "0")}`);
        vi.setSystemTime(T0 + step * 1000);
        results.push(await run(backend));
      }
      return results;
    };
    // Rows from before conversations moved into bb threads, which the store only reads and clears.
    await same(0, async ({ sql }) => {
      for (const k of KEYS) {
        await sql.run(`INSERT INTO agent_threads (target_key,thread_id,created_at) VALUES (?,?,1)`, [k, "legacy-1"]);
        await sql.run(`INSERT INTO agent_messages (target_key,role,text,context,created_at) VALUES (?,'user',?,?,1)`, [k, "Earlier question", JSON.stringify({ file: "a.ts", startLine: 1 })]);
      }
    });
    // Every review and thread the calls name; the dump adds the comment locations its reads return.
    const entities = (): StoreEntities => ({
      reviews: KEYS.map((targetKey) => ({ targetKey, generationIds: made.generations.get(targetKey) ?? [], snapshotHeads: HEADS, assessmentHeads: HEADS, locations: [] })),
      threadIds: THREADS,
    });
    for (let step = 1; step <= STEPS; step++) {
      const call = randomCall(r, made);
      const [onSqlite, onPostgres] = await same(step, ({ store }) => settle(() => call.run(store)));
      expect({ step, call: call.name, answer: onPostgres }).toEqual({ step, call: call.name, answer: onSqlite });
      const [readsSqlite, readsPostgres] = await same(step, ({ store }) => dumpStoreReads(store, entities()));
      expect({ step, call: call.name, reads: readsPostgres }).toEqual({ step, call: call.name, reads: readsSqlite });
    }
    const tables = (await backends[0].sql.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'_bb_migrations' ORDER BY name`))
      .map((row) => row.name);
    expect(tables.length).toBeGreaterThan(20);
    const [rowsSqlite, rowsPostgres] = await same(STEPS + 1, ({ sql }) => tableRows(sql, tables));
    expect(rowsPostgres).toEqual(rowsSqlite);
    await Promise.all(backends.map(({ store }) => store.dispose()));
    await sqliteHost.harness.dispose();
    await pgHost.harness.dispose();
  }, 120_000);
});
