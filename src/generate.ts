import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { completionNotifications } from "./completion-notifications";
import { defaultPreferences, guidePreferencesPrompt, reReviewCheckPrompt, spawnExecution, type ReviewPreferences } from "./preferences";
import { refreshAssistants, skipRun, startAutomaticReview } from "./agent";
import { agentPlacement, machineUnavailable } from "./machines";
import { startVerification } from "./verification";
import { baselineOf } from "./feedback-view";
import type { Guide } from "./guide";
import { approve, mayRunUnattended } from "../lib/trust";
import { fitHunks } from "./hunks";
import { spawningFor } from "./thread-review";
import { recordFormerWorker } from "./former-workers";
import { untrusted } from "./untrusted";
import { GUIDE_STOPPED } from "../lib/review-state";
import type { AsyncStore } from "./store-queue";

/** Starts a guide-writing worker's title; `agents.configure` grants it the guide tools by it. */
export const GUIDE_WORKER_TITLE = "Generate guide: ";

const preparedListeners = new WeakMap<BbPluginApi, (targetKey: string) => void>();
/** Told when a guide's automatic follow-up (the review or the feedback check) has started or can't. */
export function onPrepared(bb: BbPluginApi, listener: (targetKey: string) => void) { preparedListeners.set(bb, listener); }

const active = new WeakMap<BbPluginApi, Set<AbortController>>();
const failures = new WeakMap<BbPluginApi, Map<string, AbortController>>();
/** thread.failed: a guide worker that failed ends its generation now, instead of at the wait's timeout. */
export function guideWorkerFailed(bb: BbPluginApi, threadId: string) { failures.get(bb)?.get(threadId)?.abort(); }
/**
 * Each running generation, by its id: told when generate_review_guide accepts its guide, why it last refused one, and
 * whether the reviewer stopped it; and whether it asked for sinceReview, as a re-review does.
 */
const generations = new WeakMap<BbPluginApi, Map<string, Generation>>();
interface Generation { accepted: AbortController; rejection?: string; stopped?: boolean; sinceReview?: boolean }
/** generate_review_guide accepted generation `generationId`'s guide: its run finishes now, not when the worker's turn ends. */
export function guideAccepted(bb: BbPluginApi, generationId: string) { generations.get(bb)?.get(generationId)?.accepted.abort(); }
/** generate_review_guide refused generation `generationId`'s guide, saying `text`: the worker is reminded of it, and the reviewer told. */
export function guideRejected(bb: BbPluginApi, generationId: string, text: string) {
  const generation = generations.get(bb)?.get(generationId);
  if (generation) generation.rejection = text;
}
/** The reviewer stopped generation `generationId`: until it's finalized, generate_review_guide refuses its guide. */
export function guideStopped(bb: BbPluginApi, generationId: string): boolean { return !!generations.get(bb)?.get(generationId)?.stopped; }
/** Whether generation `generationId` asked for the guide's sinceReview: a first guide's is dropped, as there's no review to be since. */
export function guideAsksSinceReview(bb: BbPluginApi, generationId: string): boolean { return !!generations.get(bb)?.get(generationId)?.sinceReview; }

// Each wait lasts up to WAIT_STEP; a worker still working is waited for again, up to a cap that grows with the diff.
const WAIT_STEP = 600_000;
const workerActive = (status: string) => status === "starting" || status === "active" || status === "pending";
const waitCap = (patchBytes: number) => Math.min(60 * 60_000, WAIT_STEP + Math.ceil(patchBytes / 10_000) * 60_000);
export function hasGuideGenerations(bb: BbPluginApi) { return (active.get(bb)?.size ?? 0) > 0; }
export function stopGuideGenerations(bb: BbPluginApi) {
  for (const controller of active.get(bb) ?? []) controller.abort();
}

/** Each review's running generation, which the reviewer can stop: `stop` says whether it did, `done` resolves once it's finalized. */
const stoppable = new WeakMap<BbPluginApi, Map<string, { stop(): boolean; done: Promise<void> }>>();
/**
 * Stop the review's running guide, once it's finalized: "restored" when a rebuild got its previous guide back,
 * "stopped" when a first guide ended without one, null when nothing was running or its guide was already accepted.
 */
export async function stopGuide(bb: BbPluginApi, store: AsyncStore, targetKey: string): Promise<"restored" | "stopped" | null> {
  const run = stoppable.get(bb)?.get(targetKey);
  if (!run?.stop()) return null;
  await run.done;
  return (await store.getReview(targetKey))?.status === "ready" ? "restored" : "stopped";
}

/** Why a guide can't start now: the guide writer's machine is offline or removed. */
export async function guideWriterUnavailable(bb: BbPluginApi, store: AsyncStore): Promise<string | null> {
  return machineUnavailable(bb, (await store.getPreferences()).preferences.guideAgent, "guide writer");
}

/**
 * The writer's permission mode on the project's defaults. Not the project's, as its tools need no shell or edits:
 * accept-edits where the project's provider runs in it, else auto, whose approvals bb reviews itself, so the hidden
 * writer waits on no one. Unset, so the project's own, when the provider runs in neither or can't be read.
 * Pass `known` when the defaults are already read.
 */
export async function guideWriterMode(bb: BbPluginApi, projectId: string, known?: { providerId: string }): Promise<{ permissionMode?: "accept-edits" | "auto"; executionInputSources?: { permissionMode: "explicit" } }> {
  try {
    const [defaults, providers] = await Promise.all([known ?? bb.sdk.projects.defaultExecutionOptions({ projectId }), bb.sdk.providers.list()]);
    const modes = providers.find((provider) => provider.id === defaults?.providerId)?.capabilities.permissionModes ?? [];
    const mode = (["accept-edits", "auto"] as const).find((candidate) => modes.includes(candidate));
    return mode ? { permissionMode: mode, executionInputSources: { permissionMode: "explicit" } } : {};
  } catch {
    return {};
  }
}

export function buildGenerationPrompt(targetKey: string, generationId?: string, preferences: ReviewPreferences = defaultPreferences, earlier?: { guide: Guide | null; reviewed: boolean }): string {
  // The "Other files" chapter is the plugin's, made from unplaced files; kept, it would come back as a second one.
  const chapters = earlier?.guide?.sections.filter((s) => !s.id.startsWith("other-files")).map((s) => `- ${s.id}: ${s.title} (${s.diffs.map((d) => d.hunks ? `${d.file} hunks ${d.hunks.join(", ")}` : d.file).join(", ")})`) ?? [];
  return [
    "Author a review guide for this change.",
    "Follow the code-review-workspace-generate skill exactly.",
    `The target key is: ${targetKey}`,
    ...(generationId ? [`Pass generationId "${generationId}" to generate_review_guide. It identifies this exact generation run.`] : []),
    "Start with read_pr_context, then list_review_files, read the diff with read_review_patch, and submit with generate_review_guide.",
    "Take the guide's intent from what the PR says it does, and say in a chapter's overview where the code does something the description doesn't mention.",
    "Where the PR or its linked tickets say what it should do, check each ask against the diff in the guide's requirements.",
    ...(chapters.length ? ["A guide exists for an earlier revision of this change. Keep its chapter ids, titles, and order where the files still fit, so the reviewer's map of the change stays stable:", untrusted("the earlier guide's chapters", chapters.join("\n"))] : []),
    ...(earlier?.reviewed ? ["The reviewer reviewed an earlier revision. Call read_changes_since_review, then summarize what changed since their review in the guide's sinceReview field, in 2–4 sentences."] : []),
    guidePreferencesPrompt(preferences),
  ].join("\n");
}

/**
 * Build the review's guide: its start, which begins the generation, as one turn of the queue, then the rest of the run.
 * `notify: false` leaves the Needs You alert to the turn that started this re-review.
 */
export async function generateGuide(
  bb: BbPluginApi,
  store: AsyncStore,
  targetKey: string,
  projectId: string,
  /** unattended: started with no click from you, so it doesn't approve agents on the PR's head. */
  options: { notify?: boolean; unattended?: boolean } = {},
): Promise<void> {
  // A reload disposed the store before the start's turn came; the next factory finds nothing begun.
  const run = await store.exclusive((tx) => beginGuide(bb, tx, store, targetKey, projectId, options)).catch(() => null);
  await run?.();
}

/**
 * Begin the review's guide in the caller's block, `tx`, as one turn with what the caller read and wrote: the generation
 * begins, and the review is generating, before anything else reaches the store, so a second start sees it and opens it
 * as it is. Returns the rest of the run, which goes on through `store`: start it once the block has ended.
 * `notify: false` leaves the Needs You alert to the turn that started this re-review.
 */
export async function beginGuide(
  bb: BbPluginApi,
  tx: AsyncStore,
  store: AsyncStore,
  targetKey: string,
  projectId: string,
  /** unattended: started with no click from you, so it doesn't approve agents on the PR's head. */
  options: { notify?: boolean; unattended?: boolean } = {},
): Promise<() => Promise<void>> {
  let generationId: string | undefined;
  let workerId: string | undefined;
  let threads: BbPluginApi["sdk"]["threads"] | undefined;
  const controller = new AbortController();
  const generation: Generation = { accepted: new AbortController() };
  const accepted = generation.accepted;
  /** Why the guide failed, for the reviewer. */
  let failure: string | undefined;
  const runs = active.get(bb) ?? new Set<AbortController>();
  active.set(bb, runs);
  runs.add(controller);
  /** The reviewer stopped it (stopGuide), unlike a plugin reload's abort. */
  let stopped = false;
  let finished = () => {};
  const run = {
    // An accepted guide stands: it's finalizing already.
    stop: () => { if (accepted.signal.aborted || controller.signal.aborted) return false; stopped = generation.stopped = true; controller.abort(); return true; },
    done: new Promise<void>((resolve) => { finished = resolve; }),
  };
  const byReview = stoppable.get(bb) ?? new Map<string, typeof run>();
  stoppable.set(bb, byReview);
  byReview.set(targetKey, run);
  let begun: { preferences: ReviewPreferences; earlier: { guide: Guide | null; reviewed: boolean } } | { error: unknown };
  try {
    const review = await tx.getReview(targetKey);
    // A guide you start approves agents on its head, whoever wrote the PR (lib/trust.ts).
    if (!options.unattended && review?.headSha) await tx.setLifecycle(targetKey, { ...approve(review.headSha, Date.now()), skippedRun: null });
    // The diff is already the new one: hunks of the earlier guide that no longer fit it show as whole files.
    const kept = await tx.getGuide(targetKey);
    const patch = await tx.patch(targetKey);
    const earlier = { guide: kept && { ...kept, sections: fitHunks(kept.sections, patch) }, reviewed: !!(review && baselineOf(review).at) };
    generation.sinceReview = earlier.reviewed;
    // The writer this generation replaces can still run commands: as a former writer, only on its own review.
    const replaced = await tx.generationWorker(targetKey);
    if (replaced) void recordFormerWorker(bb, replaced, targetKey, "writer");
    generationId = await tx.beginGeneration(targetKey);
    await tx.setLifecycle(targetKey, { guideError: null });
    const running = generations.get(bb) ?? new Map<string, typeof generation>();
    generations.set(bb, running);
    running.set(generationId, generation);
    threads = bb.sdk.threads;
    begun = { preferences: (await tx.getPreferences()).preferences, earlier };
  } catch (error) {
    begun = { error };
  }

  return async () => {
    try {
      if ("error" in begun) throw begun.error;
      const { preferences, earlier } = begun;
      const title = `${GUIDE_WORKER_TITLE}${targetKey}`;
      const placement = await agentPlacement(bb, preferences.guideAgent, projectId);
      const execution = preferences.guideAgent ? spawnExecution(preferences.guideAgent) : await guideWriterMode(bb, projectId);
      const id = generationId!;
      const worker = await spawningFor(bb, title, targetKey, async () => {
        const worker = await bb.sdk.threads.spawn({
          ...placement,
          prompt: buildGenerationPrompt(targetKey, id, preferences, earlier),
          title,
          visibility: "hidden",
          ...execution,
        });
        // Recorded, and checked that the generation still holds it, in one turn.
        const holder = await store.exclusive(async (tx) => {
          await tx.setGenerationWorker(targetKey, id, worker.id);
          return await tx.generationOf(worker.id);
        });
        // A generation replaced while this writer spawned has no row to hold it, and its successor never saw it.
        if (holder !== targetKey) void recordFormerWorker(bb, worker.id, targetKey, "writer");
        return worker;
      });
      workerId = worker.id;
      const failed = new AbortController();
      const watched = failures.get(bb) ?? new Map<string, AbortController>();
      failures.set(bb, watched);
      watched.set(worker.id, failed);
      try {
        const deadline = Date.now() + waitCap((await store.patch(targetKey)).length);
        const signal = AbortSignal.any([controller.signal, failed.signal, accepted.signal]);
        let nudged = false;
        for (;;) {
          const started = Date.now();
          const timeoutMs = Math.min(WAIT_STEP, deadline - started);
          try {
            await threads!.wait({ threadId: worker.id, status: "idle", timeoutMs, signal });
          } catch (error) {
            // An accepted guide ends the wait: whatever the worker says after it, no one reads.
            if (accepted.signal.aborted) break;
            // Only a wait that ran its full time is tried again; any other failure ends the generation.
            if (signal.aborted || Date.now() >= deadline || Date.now() - started < timeoutMs) throw error;
            const thread = await threads!.get({ threadId: worker.id }).catch(() => null);
            if (!thread || !workerActive(thread.status)) throw error;
            continue;
          }
          // Idle without an accepted guide: the worker is told why, once, and has the rest of its time to fix it.
          if (nudged || await store.getGuide(targetKey) !== null || Date.now() >= deadline) break;
          nudged = true;
          await threads!.send({ threadId: worker.id, mode: "queue-if-active", input: [{ type: "text", mentions: [], text: generation.rejection
            ? `Your guide wasn't accepted:\n${generation.rejection}\nFix it and call generate_review_guide again with the same targetKey and generationId.`
            : "You haven't submitted the guide. Finish it and call generate_review_guide with the same targetKey and generationId." }] });
        }
        if (failed.signal.aborted && !accepted.signal.aborted) throw new Error("the guide writer failed");
        if (!accepted.signal.aborted && await store.getGuide(targetKey) === null) throw new Error("the guide writer stopped without an accepted guide");
      } finally {
        watched.delete(worker.id);
      }
    } catch (error) {
      // spawn/wait failed — fall through and finalize as error below. The log
      // carries the reason, such as a custom agent bb can no longer start, and the guide's last rejection.
      if (!controller.signal.aborted) {
        const reason = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
        failure = generation.rejection ? `Its last guide wasn't accepted:\n${generation.rejection}` : `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
        bb.log.warn(`Guide generation for ${targetKey} failed: ${String(error)}${generation.rejection ? `. Its last guide wasn't accepted:\n${generation.rejection}` : ""}`);
      }
    } finally {
      if (workerId && threads) {
        try { await threads.archive({ threadId: workerId }); } catch { /* best effort */ }
        try { await threads.stop({ threadId: workerId }); } catch { /* best effort */ }
      }
    }
    try {
      if (!generationId) return;
      const id = generationId;
      // Fenced: whether this is still the review's generation, and its outcome, in one turn.
      const outcome = await store.exclusive(async (tx) => {
        if (!await tx.isCurrentGeneration(targetKey, id)) return null;
        const ok = !controller.signal.aborted && await tx.getGuide(targetKey) !== null;
        const before = ok ? await tx.guideBackupHead(targetKey) : null;
        // A failed rebuild keeps the guide you had; a guide this run already submitted stands.
        if (ok) await tx.dropGuideBackup(targetKey);
        const putBack = !ok && await tx.restoreGuide(targetKey);
        // A rebuild you stopped is the guide you had, ready; a first guide you stopped waits for Build the guide.
        const restored = stopped && putBack;
        await tx.setStatus(targetKey, ok || restored ? "ready" : "error");
        await tx.setLifecycle(targetKey, { guideError: ok || restored ? null : stopped ? { at: Date.now(), text: GUIDE_STOPPED } : failure ? { at: Date.now(), text: failure } : null });
        bb.realtime.publish(`review:${targetKey}`, { status: ok || restored ? "ready" : "error" });
        bb.realtime.publish("reviews", { ts: Date.now() });
        // A review you already reviewed gets its feedback checked; a new one, the automatic review.
        const review = await tx.getReview(targetKey);
        // An untrusted author's check waits for your click; the automatic review gates itself.
        const preferences = (await tx.getPreferences()).preferences;
        const trusted = !!review && mayRunUnattended(review, preferences, review.headSha);
        if (ok && review && baselineOf(review).at && !trusted && reReviewCheckPrompt(preferences)) await skipRun(bb, tx, targetKey, "check", review.headSha ?? null);
        return { ok, before, review, trusted };
      });
      if (!outcome) return;
      const { ok, before, review, trusted } = outcome;
      // The review's assistant reads the new guide when its runtime restarts.
      if (ok) void refreshAssistants(bb, store, [targetKey]);
      const checking = ok && !!review && !!baselineOf(review).at && trusted && await startVerification(bb, store, targetKey, "the guide was rebuilt for the PR's new commits");
      const newCommits = before && review?.headSha && before !== review.headSha ? { from: before, to: review.headSha } : undefined;
      if (ok && !checking && !(review && baselineOf(review).at)) await startAutomaticReview(bb, store, targetKey, newCommits).catch(async (error) => {
        return store.exclusive(async (tx) => {
          bb.log.warn(`The automatic review of ${targetKey} didn't start: ${String(error)}`);
          // One that couldn't start a conversation waits for Run review, saying why; Run review is the retry. One that would
          // have waited for your click anyway, as startAutomaticReview decides after the conversation, says that instead.
          const own = review?.ownPr === true && typeof review.foreignHeadOwner !== "string";
          const held = !!review && !own && !trusted;
          if (!await tx.getAssistantThread(targetKey)) await skipRun(bb, tx, targetKey, "review", review?.headSha ?? null, held ? undefined : error instanceof Error ? error.message : String(error));
        });
      });
      if (!checking) await store.setLifecycle(targetKey, { preparedAt: Date.now() });
      preparedListeners.get(bb)?.(targetKey);
      if (!controller.signal.aborted && options.notify !== false) await completionNotifications(bb, store).queue({
        targetKey, generationId: id, projectId, status: ok ? "ready" : "error",
      });
    } catch {
      // A plugin reload can dispose storage/realtime while a worker is finishing.
      // The next factory marks interrupted runs as errors without reusing a guide.
    } finally {
      runs.delete(controller);
      if (generationId) generations.get(bb)?.delete(generationId);
      if (byReview.get(targetKey) === run) byReview.delete(targetKey);
      finished();
    }
  };
}
