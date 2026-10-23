// What bb.agents.configure reads, held in memory: BB doesn't await configure, so it can't wait its turn in the store's
// queue. The queue brings the view up to date at the end of each turn that may have changed it, before that turn's
// caller resumes, so configure sees the store as it is between turns, as it did while the Store was synchronous.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Guide } from "./guide";
import type { ReviewPreferences } from "./preferences";
import type { ReviewMeta, Store } from "./store";
import { spawnsTitled } from "./thread-review";
import { ASSISTANT_TITLE } from "./agent";
import { GUIDE_WORKER_TITLE } from "./generate";

/** Store methods that change nothing the view holds. A turn that calls any other brings it up to date. */
const KEEPS_VIEW = new Set<string>([
  "getPreferences", "getReviewerNotes", "getReview", "listReviews", "getReviewContext", "patch", "hasPatch", "patchHash",
  "diffPositions", "fileHashes", "getGuide", "guideBackupHead", "isCurrentGeneration", "generationOf", "generationWorker",
  "listGenerationWorkers", "getDraft", "staleDraftComments", "listDiscussions", "listWaitingDiscussions", "lastDiscussionChange", "getFileViews",
  "getAgentThread", "listAgentMessages", "getAssistantThread", "listAssistantThreads", "getSnapshot", "listFeedbackThreads",
  "feedbackFetched", "getAssessment", "latestAssessmentRun", "listReplyDrafts", "isDiscoveryIgnored", "draftCommentCode",
  "agentCommentChanges", "listAgentOutcomes", "reasonedRemovals",
] satisfies Array<keyof Store>);

/**
 * Store methods that can change what getGuide answers: a guide, or the patch whose renames it's read with. A turn that
 * calls one reads again the guide of the review it names, or every guide when it names none.
 */
const CHANGES_GUIDES = new Set<string>([
  "saveGuide", "beginGeneration", "backupGuide", "restoreGuide", "dropGuideBackup", "interruptGenerations", "interruptGeneration",
  "deleteReview", "savePatch", "dropPatch",
] satisfies Array<keyof Store>);

/** The review a Store call names, as its first argument or that argument's targetKey; null for one naming none. */
function namedReview(args: unknown[]): string | null {
  const [first] = args;
  if (typeof first === "string") return first;
  const targetKey = typeof first === "object" && first !== null ? (first as { targetKey?: unknown }).targetKey : undefined;
  return typeof targetKey === "string" ? targetKey : null;
}

type Thread = { id: string; title: string | null };

interface Snapshot {
  preferences: ReviewPreferences;
  assistants: Array<{ targetKey: string; threadId: string }>;
  workers: Array<{ targetKey: string; workerId: string }>;
  reviews: Map<string, ReviewMeta>;
  /** Each review's guide. A guide is read again only after a call that can change it naming its review, or naming none. */
  guides: Map<string, Guide | null>;
}

export interface ConfigureView {
  /** `backend`, telling the view of each call that may change it: queue this one, with afterTurn. */
  backend: Store;
  /** The queue's afterTurn: bring the view up to date if the turn may have changed it. A failed read is logged and tried again after the next turn. */
  afterTurn(): Promise<void>;
  /**
   * Read everything again after the next turn, guides included: for what another writer may have changed, as on
   * SQLite the instance a reload replaces can after this one read its view.
   */
  readAllAfterNextTurn(): void;
  /**
   * What a thread of this plugin is: the assistant or guide writer it's recorded as, whatever its title now, or, only
   * while a spawn with its exact title is in flight, what that title names. Null for any other thread.
   */
  threadRole(thread: Thread): "assistant" | "writer" | null;
  /** The review a thread of this plugin belongs to, as threadReview (src/thread-review.ts) reads it from the store. */
  threadReview(thread: Thread): string | null;
  preferences(): ReviewPreferences;
  review(targetKey: string): ReviewMeta | null;
  guide(targetKey: string): Guide | null;
}

/** The view read from `backend`, reading again only the guides of `changed` reviews, or every guide. */
async function load(backend: Store, previous: Snapshot | null, changed: ReadonlySet<string> | "all" | null): Promise<Snapshot> {
  const preferences = (await backend.getPreferences()).preferences;
  const assistants = await backend.listAssistantThreads();
  const workers = await backend.listGenerationWorkers();
  const reviews = new Map((await backend.listReviews()).map((review) => [review.targetKey, review] as const));
  const guides: Snapshot["guides"] = new Map();
  for (const targetKey of reviews.keys()) {
    const kept = previous && changed !== "all" && !changed?.has(targetKey) && previous.guides.has(targetKey);
    guides.set(targetKey, kept ? previous.guides.get(targetKey)! : await backend.getGuide(targetKey));
  }
  return { preferences, assistants, workers, reviews, guides };
}

/** The view of `backend`, read now: create it before anything else reaches the store. */
export async function createConfigureView(bb: BbPluginApi, backend: Store): Promise<ConfigureView> {
  let snapshot = await load(backend, null, "all");
  /** Whether a call since the view was last brought up to date may have changed it. */
  let changed = false;
  /** Since then, the reviews whose guides calls may have changed, or "all" after one naming none. */
  let guides: Set<string> | "all" | null = null;
  // Each method runs on `backend` itself, so its own calls to its other methods aren't seen here.
  const tracked: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(backend)) {
    if (typeof method !== "function") continue;
    tracked[name] = (...args: unknown[]) => {
      if (!KEEPS_VIEW.has(name)) changed = true;
      if (CHANGES_GUIDES.has(name)) {
        const targetKey = namedReview(args);
        if (targetKey === null) guides = "all";
        else if (guides !== "all") guides = (guides ?? new Set<string>()).add(targetKey);
      }
      return (method as (...args: unknown[]) => unknown).apply(backend, args);
    };
  }
  const assistantReview = (threadId: string) => snapshot.assistants.find((thread) => thread.threadId === threadId)?.targetKey ?? null;
  const generationOf = (workerId: string) => snapshot.workers.find((worker) => worker.workerId === workerId)?.targetKey ?? null;
  return {
    backend: tracked as unknown as Store,
    async afterTurn() {
      if (!changed) return;
      const reading = guides;
      changed = false;
      guides = null;
      try {
        snapshot = await load(backend, snapshot, reading);
      } catch (error) {
        // Read again after the next turn, with what this one changed.
        changed = true;
        guides = reading === "all" || guides === "all" ? "all" : reading || guides ? new Set([...reading ?? [], ...guides ?? []]) : null;
        bb.log.warn(`Could not read what agents are configured with: ${String(error)}`);
      }
    },
    readAllAfterNextTurn() {
      changed = true;
      guides = "all";
    },
    threadRole(thread) {
      if (assistantReview(thread.id)) return "assistant";
      if (generationOf(thread.id)) return "writer";
      for (const { title } of spawnsTitled(bb, thread.title)) {
        if (title.startsWith(GUIDE_WORKER_TITLE)) return "writer";
        if (title.startsWith(ASSISTANT_TITLE)) return "assistant";
      }
      return null;
    },
    threadReview(thread) {
      const recorded = assistantReview(thread.id) ?? generationOf(thread.id);
      if (recorded) return recorded;
      return spawnsTitled(bb, thread.title)[0]?.targetKey ?? null;
    },
    preferences: () => snapshot.preferences,
    review: (targetKey) => snapshot.reviews.get(targetKey) ?? null,
    guide: (targetKey) => snapshot.guides.get(targetKey) ?? null,
  };
}
