/**
 * A deterministic dump of every Store read, and checksums of a plugin database's tables: run on the same data before and
 * after a change to the store, they show its behaviour didn't change. dumpDatabase runs both on a copy of a data.db;
 * scripts/store-dump.ts is its command line.
 *
 * The reads go through an AsyncStore, so they don't depend on whether the backend is synchronous. Some reads write (a
 * patch's missing hash, files moved by a rename), so they run in a fixed order, on a copy.
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { CommentLocation } from "../src/draft";
import { createStore } from "../src/store";
import { queueStore, type AsyncStore } from "../src/store-queue";

/** What the per-review reads are asked about: every review key and entity in the data. */
export interface StoreEntities {
  reviews: Array<{
    targetKey: string;
    generationIds: string[];
    snapshotHeads: string[];
    assessmentHeads: string[];
    /** Comment locations with rows behind them; the dump adds the ones its reads return. */
    locations: CommentLocation[];
  }>;
  /** Threads the store may know as a generation's worker, an assistant thread, or a legacy agent thread. */
  threadIds: string[];
}

export type TableChecksums = Record<string, { columns: string[]; rows: number; sha256: string }>;

const quoteName = (name: string) => `"${name.replaceAll(`"`, `""`)}"`;
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

function tableNames(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quoteName(table)})`).all() as Array<{ name: string }>).map((row) => row.name);
}

/** The review keys and entities in a plugin database, read from its tables directly, before the store opens it. */
export function storeEntities(db: Database.Database): StoreEntities {
  const tables = tableNames(db);
  const has = (table: string) => tables.includes(table);
  const rows = <T>(table: string, sql: string): T[] => has(table) ? db.prepare(sql).all() as T[] : [];
  const keyed = tables.filter((table) => columnNames(db, table).includes("target_key"));
  const targetKeys = sorted(keyed.flatMap((table) => rows<{ target_key: string }>(table, `SELECT DISTINCT target_key FROM ${quoteName(table)}`).map((row) => row.target_key)));
  const generations = rows<{ target_key: string; generation_id: string; worker_id: string | null }>("generations", `SELECT * FROM generations`);
  const heads = (...tablesWithHeads: string[]) => tablesWithHeads.flatMap((table) => rows<{ target_key: string; head_sha: string }>(table, `SELECT DISTINCT target_key, head_sha FROM ${quoteName(table)}`));
  const snapshots = heads("review_snapshots"), assessments = heads("assessment_items", "assessment_runs");
  const located = ["draft_comment_revisions", "discussion_entries", "discussion_waits", "agent_comment_changes"]
    .flatMap((table) => rows<CommentLocation & { target_key: string }>(table, `SELECT DISTINCT target_key, file, line, side FROM ${quoteName(table)}`));
  return {
    reviews: targetKeys.map((targetKey) => ({
      targetKey,
      generationIds: sorted(generations.filter((g) => g.target_key === targetKey).map((g) => g.generation_id)),
      snapshotHeads: sorted(snapshots.filter((s) => s.target_key === targetKey).map((s) => s.head_sha)),
      assessmentHeads: sorted(assessments.filter((a) => a.target_key === targetKey).map((a) => a.head_sha)),
      locations: sortedLocations(located.filter((l) => l.target_key === targetKey)),
    })),
    threadIds: sorted([
      ...generations.flatMap((g) => g.worker_id === null ? [] : [g.worker_id]),
      ...rows<{ thread_id: string }>("assistant_threads", `SELECT thread_id FROM assistant_threads`).map((row) => row.thread_id),
      ...rows<{ thread_id: string }>("agent_threads", `SELECT thread_id FROM agent_threads`).map((row) => row.thread_id),
    ]),
  };
}

/** Distinct locations, by file, line, then side. */
function sortedLocations(locations: Iterable<CommentLocation>): CommentLocation[] {
  const byKey = new Map<string, CommentLocation>();
  for (const { file, line, side } of locations) byKey.set(JSON.stringify([file, line, side]), { file, line, side });
  return [...byKey.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.side < b.side ? -1 : a.side > b.side ? 1 : 0));
}

/**
 * A value as plain JSON that tells apart what JSON wouldn't: Maps (entries in their order), Sets, bigints, and
 * undefined outside an object. Object keys are sorted; a property that is undefined is left out, as JSON does.
 */
export function canonical(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { $number: String(value) };
  if (typeof value === "bigint") return { $bigint: String(value) };
  if (typeof value === "function") return { $function: true };
  if (value instanceof Map) return { $map: [...value].map(([k, v]) => [canonical(k), canonical(v)]) };
  if (value instanceof Set) return { $set: [...value].map(canonical) };
  if (Array.isArray(value)) return value.map(canonical);
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => [key, canonical(object[key])]));
}

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
/** Long text (whole patches) as its length and hash. */
const digest = (text: string | null) => text === null ? null : { length: text.length, sha256: sha256(text) };

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/** A read's result for the dump, through `shape` (canonical by default); a throw is recorded as `$throws`. */
const recorded = <T>(result: Settled<T>, shape: (value: T) => unknown = canonical) => result.ok ? shape(result.value) : { $throws: result.error };
const read = async <T>(call: () => Promise<T>, shape?: (value: T) => unknown) => recorded(await settle(call), shape);

/** Every Store read, for every review and entity in `entities`, in a fixed order. */
export async function dumpStoreReads(store: AsyncStore, entities: StoreEntities) {
  const global: Record<string, unknown> = {};
  global.getPreferences = await read(() => store.getPreferences());
  global.listReviews = await read(() => store.listReviews());
  global.listAssistantThreads = await read(() => store.listAssistantThreads());
  global.reasonedRemovals = await read(() => store.reasonedRemovals());
  global.listAgentOutcomes = await read(() => store.listAgentOutcomes());
  global.listFilterViews = await read(() => store.listFilterViews());
  const generationOf: Record<string, unknown> = {};
  for (const threadId of entities.threadIds) generationOf[threadId] = await read(() => store.generationOf(threadId));
  global.generationOf = generationOf;

  const reviews: Record<string, unknown> = {};
  for (const { targetKey: k, generationIds, snapshotHeads, assessmentHeads, locations } of entities.reviews) {
    const review: Record<string, unknown> = {};
    review.getReview = await read(() => store.getReview(k));
    review.getReviewerNotes = await read(() => store.getReviewerNotes(k));
    review.getReviewContext = await read(() => store.getReviewContext(k));
    review.hasPatch = await read(() => store.hasPatch(k));
    review.patchHash = await read(() => store.patchHash(k));
    review.patch = await read(() => store.patch(k), digest);
    const positions = await settle(() => store.diffPositions(k));
    // Each file's commentable lines, hashed: they hold the patch's text.
    review.diffPositions = recorded(positions, (byFile) => [...byFile].map(([file, { left, right }]) => [file, { left: left.size, right: right.size, sha256: sha256(JSON.stringify([[...left], [...right]])) }]));
    review.getGuide = await read(() => store.getGuide(k));
    review.guideBackupHead = await read(() => store.guideBackupHead(k));
    review.generationWorker = await read(() => store.generationWorker(k));
    const current: Record<string, unknown> = {};
    for (const id of generationIds) current[id] = await read(() => store.isCurrentGeneration(k, id));
    review.isCurrentGeneration = current;
    const draft = await settle(() => store.getDraft(k));
    review.getDraft = recorded(draft);
    review.staleDraftComments = await read(() => store.staleDraftComments(k));
    const discussions = await settle(() => store.listDiscussions(k));
    review.listDiscussions = recorded(discussions);
    const views = await settle(() => store.getFileViews(k));
    review.getFileViews = recorded(views);
    // Hashes of the diff's files and the viewed ones, as the Viewed marks ask for them.
    const files = sorted([...(positions.ok ? positions.value.keys() : []), ...(views.ok ? views.value.map((v) => v.file) : [])]);
    review.fileHashes = await read(() => store.fileHashes(k), (hashes) => ({ files, current: canonical(hashes.current(files)), legacy: canonical(hashes.legacy(files)) }));
    review.getAgentThread = await read(() => store.getAgentThread(k));
    review.listAgentMessages = await read(() => store.listAgentMessages(k));
    review.getAssistantThread = await read(() => store.getAssistantThread(k));
    review.listFeedbackThreads = await read(() => store.listFeedbackThreads(k));
    review.feedbackFetched = await read(() => store.feedbackFetched(k));
    review.latestAssessmentRun = await read(() => store.latestAssessmentRun(k));
    review.listReplyDrafts = await read(() => store.listReplyDrafts(k));
    review.isDiscoveryIgnored = await read(() => store.isDiscoveryIgnored(k));
    const changes = await settle(() => store.agentCommentChanges(k));
    review.agentCommentChanges = recorded(changes);
    const snapshots: Record<string, unknown> = {};
    for (const head of snapshotHeads) snapshots[head] = await read(() => store.getSnapshot(k, head), digest);
    review.getSnapshot = snapshots;
    const assessments: Record<string, unknown> = {};
    for (const head of assessmentHeads) assessments[head] = await read(() => store.getAssessment(k, head));
    review.getAssessment = assessments;
    // Locations with rows, and those the draft, discussions and agent comment changes read back, after any renames moved them.
    const at: CommentLocation[] = [
      ...locations,
      ...(draft.ok ? draft.value.comments : []),
      ...(discussions.ok ? discussions.value : []),
      ...(changes.ok ? changes.value : []),
    ];
    const byLocation: unknown[] = [];
    for (const location of sortedLocations(at)) {
      byLocation.push({
        at: location,
        draftCommentCode: await read(() => store.draftCommentCode(k, location)),
        draftCommentStartCode: await read(() => store.draftCommentCode(k, location, "start")),
        lastDiscussionChange: await read(() => store.lastDiscussionChange(k, location)),
      });
    }
    review.locations = byLocation;
    reviews[k] = review;
  }
  return { format: "crw-store-reads/1", global, reviews };
}

/** The dump as text: indented JSON with a final newline. */
export function formatDump(dump: unknown): string {
  return JSON.stringify(dump, null, 2) + "\n";
}

/**
 * Each table's columns (by name), row count, and the SHA-256 of its rows in a canonical order: each row a JSON array of
 * its values in column-name order, each tagged with its storage class (i: integer, r: real, t: text, b: blob), and
 * the rows sorted. Insertion order and column order don't change it; a value's type does.
 */
export function tableChecksums(db: Database.Database): TableChecksums {
  const checksums: TableChecksums = {};
  for (const table of tableNames(db)) {
    const columns = columnNames(db, table).sort();
    const lines: string[] = [];
    const select = db.prepare(`SELECT ${columns.map(quoteName).join(", ")} FROM ${quoteName(table)}`).raw(true).safeIntegers(true);
    for (const row of select.iterate() as Iterable<unknown[]>) lines.push(JSON.stringify(row.map(taggedValue)));
    lines.sort();
    checksums[table] = { columns, rows: lines.length, sha256: sha256(lines.join("\n")) };
  }
  return checksums;
}

function taggedValue(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "bigint") return `i:${value}`;
  if (typeof value === "number") return `r:${value}`;
  if (typeof value === "string") return `t:${value}`;
  if (Buffer.isBuffer(value)) return `b:${value.toString("hex")}`;
  throw new Error(`Unexpected SQLite value: ${typeof value}`);
}

/** The reads dump and checksums of a copy of `source`, opened through the plugin's own store on the SDK's fake host. */
export async function dumpDatabase(source: string): Promise<{ reads: string; checksums: string }> {
  if (existsSync(`${source}-wal`)) throw new Error(`${source} has a WAL file: dump a consistent snapshot of it instead`);
  const sourceBytes = readFileSync(source);
  // An empty data dir, so the store finds no former install to import.
  const dataDir = mkdtempSync(join(tmpdir(), "crw-store-dump-"));
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", dataDir });
  try {
    // The fake host's database, in its own temp directory, replaced by the copy before the store opens it.
    const empty = bb.storage.database();
    empty.close();
    copyFileSync(source, empty.name);
    chmodSync(empty.name, 0o600);
    const db = bb.storage.database();
    const before = tableChecksums(db);
    const entities = storeEntities(db);
    const store = queueStore(createStore(bb));
    const reads = formatDump(await dumpStoreReads(store, entities));
    await store.dispose();
    const after = tableChecksums(db);
    return { reads, checksums: formatDump({ format: "crw-table-checksums/1", source: { bytes: sourceBytes.length, sha256: sha256(sourceBytes) }, before, after }) };
  } finally {
    await harness.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
