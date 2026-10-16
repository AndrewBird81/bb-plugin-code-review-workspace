import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { completionNotifications } from "./completion-notifications";
import { defaultPreferences, guidePreferencesPrompt, reReviewCheckPrompt, spawnExecution, type ReviewPreferences } from "./preferences";
import { refreshAssistants, skipRun, startAutomaticReview } from "./agent";
import { agentPlacement, machineUnavailable } from "./machines";
import { startVerification } from "./verification";
import { baselineOf } from "./feedback-view";
import type { Guide } from "./guide";
import { mayRunUnattended } from "../lib/trust";
import { fitHunks } from "./hunks";
import { spawningFor } from "./thread-review";
import { untrusted } from "./untrusted";

/** Starts a guide-writing worker's title; `agents.configure` grants it the guide tools by it. */
export const GUIDE_WORKER_TITLE = "Generate guide: ";

const preparedListeners = new WeakMap<BbPluginApi, (targetKey: string) => void>();
/** Told when a guide's automatic follow-up (the review or the feedback check) has started or can't. */
export function onPrepared(bb: BbPluginApi, listener: (targetKey: string) => void) { preparedListeners.set(bb, listener); }

const active = new WeakMap<BbPluginApi, Set<AbortController>>();
const failures = new WeakMap<BbPluginApi, Map<string, AbortController>>();
/** thread.failed: a guide worker that failed ends its generation now, instead of at the wait's timeout. */
export function guideWorkerFailed(bb: BbPluginApi, threadId: string) { failures.get(bb)?.get(threadId)?.abort(); }

// Each wait lasts up to WAIT_STEP; a worker still working is waited for again, up to a cap that grows with the diff.
const WAIT_STEP = 600_000;
const workerActive = (status: string) => status === "starting" || status === "active" || status === "pending";
const waitCap = (patchBytes: number) => Math.min(60 * 60_000, WAIT_STEP + Math.ceil(patchBytes / 10_000) * 60_000);
export function hasGuideGenerations(bb: BbPluginApi) { return (active.get(bb)?.size ?? 0) > 0; }
export function stopGuideGenerations(bb: BbPluginApi) {
  for (const controller of active.get(bb) ?? []) controller.abort();
}

/** Why a guide can't start now: the guide writer's machine is offline or removed. */
export function guideWriterUnavailable(bb: BbPluginApi, store: Store): Promise<string | null> {
  return machineUnavailable(bb, store.getPreferences().preferences.guideAgent, "guide writer");
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
  const chapters = earlier?.guide?.sections.map((s) => `- ${s.id}: ${s.title} (${s.diffs.map((d) => d.hunks ? `${d.file} hunks ${d.hunks.join(", ")}` : d.file).join(", ")})`) ?? [];
  return [
    "Author a Guided Review for this change.",
    "Follow the guided-review-generate skill exactly.",
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

/** `notify: false` leaves the Needs You alert to the turn that started this re-review. */
export async function generateGuide(
  bb: BbPluginApi,
  store: Store,
  targetKey: string,
  projectId: string,
  /** unattended: started with no click from you, so it doesn't approve agents on the PR's head. */
  options: { notify?: boolean; unattended?: boolean } = {},
): Promise<void> {
  let generationId: string | undefined;
  let workerId: string | undefined;
  let threads: BbPluginApi["sdk"]["threads"] | undefined;
  const controller = new AbortController();
  const runs = active.get(bb) ?? new Set<AbortController>();
  active.set(bb, runs);
  runs.add(controller);
  try {
    const review = store.getReview(targetKey);
    // A guide you start approves agents on its head, whoever wrote the PR (lib/trust.ts).
    if (!options.unattended && review?.headSha) store.setLifecycle(targetKey, { approvedHead: review.headSha, skippedRun: null });
    // The diff is already the new one: hunks of the earlier guide that no longer fit it show as whole files.
    const kept = store.getGuide(targetKey);
    const patch = store.patch(targetKey);
    const earlier = { guide: kept && { ...kept, sections: fitHunks(kept.sections, patch) }, reviewed: !!(review && baselineOf(review).at) };
    generationId = store.beginGeneration(targetKey);
    threads = bb.sdk.threads;
    const preferences = store.getPreferences().preferences;
    const title = `${GUIDE_WORKER_TITLE}${targetKey}`;
    const placement = await agentPlacement(bb, preferences.guideAgent, projectId);
    const execution = preferences.guideAgent ? spawnExecution(preferences.guideAgent) : await guideWriterMode(bb, projectId);
    const id = generationId;
    const worker = await spawningFor(bb, title, targetKey, async () => {
      const worker = await bb.sdk.threads.spawn({
        ...placement,
        prompt: buildGenerationPrompt(targetKey, id, preferences, earlier),
        title,
        visibility: "hidden",
        ...execution,
      });
      store.setGenerationWorker(targetKey, id, worker.id);
      return worker;
    });
    workerId = worker.id;
    const failed = new AbortController();
    const watched = failures.get(bb) ?? new Map<string, AbortController>();
    failures.set(bb, watched);
    watched.set(worker.id, failed);
    try {
      const deadline = Date.now() + waitCap(store.patch(targetKey).length);
      const signal = AbortSignal.any([controller.signal, failed.signal]);
      for (;;) {
        const started = Date.now();
        const timeoutMs = Math.min(WAIT_STEP, deadline - started);
        try {
          await threads.wait({ threadId: worker.id, status: "idle", timeoutMs, signal });
          break;
        } catch (error) {
          // Only a wait that ran its full time is tried again; any other failure ends the generation.
          if (signal.aborted || Date.now() >= deadline || Date.now() - started < timeoutMs) throw error;
          const thread = await threads.get({ threadId: worker.id }).catch(() => null);
          if (!thread || !workerActive(thread.status)) throw error;
        }
      }
      if (failed.signal.aborted) throw new Error("the worker failed");
    } finally {
      watched.delete(worker.id);
    }
  } catch (error) {
    // spawn/wait failed — fall through and finalize as error below. The log
    // carries the reason, such as a custom agent bb can no longer start.
    if (!controller.signal.aborted) bb.log.warn(`Guide generation for ${targetKey} failed: ${String(error)}`);
  } finally {
    if (workerId && threads) {
      try { await threads.archive({ threadId: workerId }); } catch { /* best effort */ }
      try { await threads.stop({ threadId: workerId }); } catch { /* best effort */ }
    }
  }
  try {
    if (!generationId || !store.isCurrentGeneration(targetKey, generationId)) return;
    const ok = !controller.signal.aborted && store.getGuide(targetKey) !== null;
    const before = ok ? store.guideBackupHead(targetKey) : null;
    // A failed rebuild keeps the guide you had; a guide this run already submitted stands.
    if (ok) store.dropGuideBackup(targetKey);
    else store.restoreGuide(targetKey);
    store.setStatus(targetKey, ok ? "ready" : "error");
    // The review's assistant reads the new guide when its runtime restarts.
    if (ok) void refreshAssistants(bb, store, [targetKey]);
    bb.realtime.publish(`review:${targetKey}`, { status: ok ? "ready" : "error" });
    bb.realtime.publish("reviews", { ts: Date.now() });
    // A review you already reviewed gets its feedback checked; a new one, the automatic review.
    const review = store.getReview(targetKey);
    // An untrusted author's check waits for your click; the automatic review gates itself.
    const preferences = store.getPreferences().preferences;
    const trusted = !!review && mayRunUnattended(review, preferences, review.headSha);
    if (ok && review && baselineOf(review).at && !trusted && reReviewCheckPrompt(preferences)) skipRun(bb, store, targetKey, "check", review.headSha ?? null);
    const checking = ok && !!review && !!baselineOf(review).at && trusted && await startVerification(bb, store, targetKey, "the guide was rebuilt for the PR's new commits");
    const newCommits = before && review?.headSha && before !== review.headSha ? { from: before, to: review.headSha } : undefined;
    if (ok && !checking && !(review && baselineOf(review).at)) await startAutomaticReview(bb, store, targetKey, newCommits).catch((error) => {
      bb.log.warn(`The automatic review of ${targetKey} didn't start: ${String(error)}`);
    });
    if (!checking) store.setLifecycle(targetKey, { preparedAt: Date.now() });
    preparedListeners.get(bb)?.(targetKey);
    if (!controller.signal.aborted && options.notify !== false) await completionNotifications(bb, store).queue({
      targetKey, generationId, projectId, status: ok ? "ready" : "error",
    });
  } catch {
    // A plugin reload can dispose storage/realtime while a worker is finishing.
    // The next factory marks interrupted runs as errors without reusing a guide.
  } finally {
    runs.delete(controller);
  }
}
