// bb-plugin-code-review-workspace — backend entry.
//
// Turns a GitHub PR (or local git ref) into an agent-authored chaptered
// walkthrough, rendered and reviewed in a bb panel, submitted back to GitHub.
import type { BbPluginApi, PluginAgentConfiguration, PluginAgentConfigurationContext, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { rpcContract } from "./src/rpc-contract";
import { createStore, storeOn, type Store } from "./src/store";
import { codeOwners } from "./src/codeowners";
import { runReviewCommand } from "./src/review-command";
import { assistantInstructions, assistantMayAnswer, endAssistantWaits, threadMayAnswer, onAssistantWaitsEnded, refreshAssistants } from "./src/agent";
import { personalProjectId } from "./src/machines";
import { assistantReview } from "./src/draft-comments";
import { askAt, clearAsks, listAsks, setAsk } from "./src/asks";
import { runGh, runGit } from "./src/gh";
import { createReviewSync } from "./src/review-lifecycle";
import { setTimeout as delay } from "node:timers/promises";
import { createReviewSubmitter } from "./src/submit-review";
import { createGithubWrites } from "./src/github-writes";
import { postReceipts } from "./src/post-receipts";
import { GUIDE_WORKER_TITLE, failUnfinishedGuides, stopGuideGenerations, hasGuideGenerations } from "./src/generate";
import { pluginThreadsTitled, toolThreadReview } from "./src/thread-review";
import { formerWorkerReview, recordFormerWorker } from "./src/former-workers";
import { rerunReview } from "./src/rereview";
import { completionNotifications } from "./src/completion-notifications";
import { createPluginUpdates } from "./src/plugin-updates";
import { onPrepared } from "./src/generate";
import { baselineOf, guideBehind, pruneOldDiffs } from "./src/feedback-view";
import { startVerification } from "./src/verification";
import { fetchMyThreads } from "./src/github/threads";
import type { ReviewMeta } from "./src/store";
import { threadSignals } from "./src/turn-signals";
import { mayRunChecks } from "./lib/trust";
import { interruptedGuideThrew, restartInterruptedGuide, retryInterruptedGuides } from "./src/interrupted-guides";
import { createInstructionSuggester } from "./src/learning";
import { FORMER_PLUGIN_ID } from "./src/former-install";
import { queueStore, type QueuedStore } from "./src/store-queue";
import { createConfigureView } from "./src/configure-view";
import { chooseStorage, openPostgres, unlessAborted } from "./src/storage";
import { createStorageCommand } from "./src/storage-cli";
import { migratePg, pgSchemaMigrated } from "./src/db/pg-migrations";
import { listen, merge, ASSISTANT_TOOLS, ASSISTANT_TOOL_NAMES, ASSISTANT_WRITE_TOOL_NAMES, SUBCOMMANDS, WRITER_TOOL_NAMES, type RpcHandlers, type ServeDeps, type Subcommands } from "./src/server-modules";
import * as settingsRpc from "./src/settings-rpc";
import * as reviewsRpc from "./src/reviews-rpc";
import * as githubThreadsRpc from "./src/github-threads-rpc";
import * as draftRpc from "./src/draft-rpc";
import * as assistantRpc from "./src/assistant-rpc";
import * as turnRpc from "./src/turn-rpc";
import * as patchTools from "./src/patch-tools";
import * as draftTools from "./src/draft-tools";
import * as feedbackTools from "./src/feedback-tools";
import * as assistantEvents from "./src/assistant-events";
import * as guideTool from "./src/guide-tool";
import * as featureReview from "./src/feature-review";
import * as rpcStubs from "./src/rpc-stubs";
import * as reviewAgentTools from "./src/review-agent-tools";
import * as relaysModule from "./src/relays";
import { createClassifier, fromOwnAgent, ledgerEvents } from "./src/asking";

export { rpcContract } from "./src/rpc-contract";


/** How long a wait on the assistant, or an ask, stands before a review-state pass checks whether its turn ended unheard. */
const WAIT_GRACE = 2 * 60_000;

/** What the plugin serves from its open store. BB takes services, schedules and the configure and CLI registrations from the factory alone, which hands them on to these. */
interface Served {
  store: QueuedStore;
  configure(context: PluginAgentConfigurationContext): PluginAgentConfiguration;
  run(argv: string[], ctx: PluginCliContext): Promise<PluginCliResult>;
  checkUpdates(signal: AbortSignal): Promise<void>;
  syncReviews(signal: AbortSignal): Promise<void>;
  pruneOld(): Promise<void>;
}

export default async function plugin(bb: BbPluginApi) {
  const storage = await chooseStorage(bb);
  let served: Served | null = null;
  let serve: (opened: Served) => void = () => {};
  const serving = new Promise<Served>((resolve) => { serve = (opened) => { served = opened; resolve(opened); }; });
  // bb.agents.configure must answer synchronously, every time: until the store is open, it gives no thread anything.
  bb.agents.configure((context) => served?.configure(context) ?? { tools: [], skills: [] });
  const storageCommand = createStorageCommand(bb, storage);
  bb.cli.register({
    name: "review",
    summary: "Open a review of a GitHub PR or local git ref in Code Review Workspace, or change its local draft",
    rendersHelp: true,
    commands: SUBCOMMANDS,
    async run(argv, ctx) {
      // Storage answers in maintenance too, where the reviews move between backends.
      if (argv[0] === "storage") return storageCommand(argv.slice(1), ctx);
      if (served) return served.run(argv, ctx);
      const { state, problem } = storage.status;
      if (state === "maintenance") return { exitCode: 1, stderr: problem! };
      return { exitCode: 1, stderr: `Code Review Workspace is opening its Postgres storage${problem ? ` (latest try: ${problem})` : ""}. Try again in a moment; bb review storage status says more.` };
    },
  });
  if (storage.kind === "maintenance") {
    bb.log.warn(storage.status.problem!);
    bb.status.needsConfiguration(storage.status.problem!);
    return;
  }
  bb.background.service("plugin-updates", { start: async (signal) => { await (await unlessAborted(serving, signal))?.checkUpdates(signal); } });
  bb.background.service("review-state", { start: async (signal) => { await (await unlessAborted(serving, signal))?.syncReviews(signal); } });
  // Once a day, drop the stored diffs of reviews out of play for a month. BB keeps the schedule, so a reload doesn't prune again.
  bb.background.schedule("prune-old-diffs", "17 4 * * *", async () => { await served?.pruneOld(); });
  if (storage.kind === "sqlite") {
    serve(servePlugin(bb, await openStore(bb, createStore(bb)), true));
    return;
  }
  const { pg, schema } = storage;
  // The guides a reload interrupted, kept across tries of the open: a try that fails after interrupting them leaves the
  // next none to find.
  const interrupted: Interrupted[] = [];
  // Opened at activation, once the instance a reload replaces has closed its connection and let the writer lock go.
  bb.background.service("storage", {
    async start(signal) {
      // BB restarts a service for an uncaught error in work started from it, as the store's is: run again, it finds the store open.
      if (!served) {
        const opened = await openPostgres(bb, storage, signal, async () => {
          await pg.lockWriter();
          // The reviews are in Postgres, by storage:owner: a schema without them is the wrong one, not one to make.
          if (!await pgSchemaMigrated(pg, schema)) throw new Error(`storage:owner says the reviews are in Postgres, but schema "${schema}" holds none: check postgresUrl and postgresSchema, then reload`);
          await migratePg(pg, schema);
          return await openStore(bb, storeOn(pg), interrupted);
        });
        if (!opened) return;
        serve(servePlugin(bb, opened));
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => { resolve(); }, { once: true });
      });
    },
  });
  bb.onDispose(async () => {
    // Calls still queued, and later ones, reject; closing the connection lets the writer lock go for the next instance.
    await served?.store.dispose();
    await pg.end();
  });
}

type Interrupted = Awaited<ReturnType<Store["interruptGenerations"]>>[number];

/**
 * The store over `backend`: configure's view of it, read first, and the guides a reload interrupted, before anything
 * else reaches it. They're added to `interrupted`, which an open tried again passes again.
 */
async function openStore(bb: BbPluginApi, backend: Store, interrupted: Interrupted[] = []) {
  // bb.agents.configure must answer synchronously, so it reads a view the queue keeps up to date; everything else
  // takes its turn in the queue.
  const configured = await createConfigureView(bb, backend);
  const store = queueStore(configured.backend, { afterTurn: configured.afterTurn });
  await store.exclusive(async (tx) => {
    for (const found of await tx.interruptGenerations()) if (!interrupted.some((known) => known.targetKey === found.targetKey)) interrupted.push(found);
    // An ask on a summary or comment can't know whether its turn ended while the plugin was down; it gives way.
    for (const review of await tx.listReviews()) if (listAsks(review).length) await clearAsks(tx, review.targetKey);
  });
  return { configured, store, interrupted };
}

/**
 * Register the tools, RPC handlers and events, and start what runs on the open store. Nothing in it awaits.
 * `sharedWithReplaced`: the instance a reload replaces can still write to the store, as on SQLite.
 */
function servePlugin(bb: BbPluginApi, { configured, store, interrupted }: Awaited<ReturnType<typeof openStore>>, sharedWithReplaced = false): Served {
  const receipts = postReceipts(bb.storage.kv);
  const githubWrites = createGithubWrites();
  const submitReview = createReviewSubmitter(store, runGh, receipts, githubWrites.pace);
  const deps = { bb, store, gh: { runGh, runGit } };
  const notifications = completionNotifications(bb, store);
  const suggester = createInstructionSuggester(bb, store, () => bb.realtime.publish("learning", {}));
  let personalProject: string | null = null;
  const reasons: Record<string, string> = {
    "re-requested": "the author re-requested the reviewer's review", handled: "every thread of the reviewer's feedback is resolved or answered",
    "looks-ready": "the last check found the feedback addressed", dismissed: "GitHub dismissed the reviewer's review",
  };
  const sync = createReviewSync(bb, store, runGh, { actions: {
    async prepare(targetKey, reason) {
      const review = await store.getReview(targetKey);
      if (!review) return false;
      // An out-of-date guide is rebuilt first; its completion starts the check.
      if (review.status === "tracked" || guideBehind(review)) return (await rerunReview(deps, targetKey, { notify: false, unattended: true })).ok;
      return startVerification(bb, store, targetKey, reasons[reason] ?? "the review came back to the reviewer", "automatic");
    },
    checkPushes: (targetKey) => startVerification(bb, store, targetKey, "the author pushed new commits and they have settled", "automatic"),
    async autoStart(targetKey) {
      return (await rerunReview(deps, targetKey, { notify: false, unattended: true })).ok;
    },
    async projectId() {
      if (personalProject) return personalProject;
      personalProject = (await personalProjectId(bb).catch(() => undefined)) ?? null;
      return personalProject;
    },
    becomePr: (targetKey, pr) => featureReview.becomePr({ ...deps, changed: (key) => changed(key) }, targetKey, pr),
  } });
  onPrepared(bb, (targetKey) => { void sync.evaluate(targetKey); });
  onAssistantWaitsEnded(bb, (targetKey) => { void sync.evaluate(targetKey); });
  // Guides a reload interrupted: their workers stop, and the rebuilds start again without alerting. Their rows are gone,
  // so each writer is recorded now: as a former writer, it can still run commands only on its own review.
  for (const { targetKey, workerId } of interrupted) if (workerId) void recordFormerWorker(bb, workerId, targetKey, "writer");
  void (async () => {
    for (const { targetKey, workerId } of interrupted) await (async () => {
      // A writer whose spawn the reload interrupted has no recorded id, so it's found by its exact title, before the
      // restart spawns another, and kept to its review too. One a generation since records is that generation's. A title
      // is the thread's own to write, so an assistant, or a former worker kept to another review or to none, stays as it is.
      const writers = await pluginThreadsTitled(bb, `${GUIDE_WORKER_TITLE}${targetKey}`).catch((error) => {
        bb.log.warn(`Could not list the guide writers of ${targetKey}: ${String(error)}`);
        return [];
      });
      const titled = await store.exclusive(async (tx) => {
        const titled: string[] = [];
        for (const threadId of writers) if (threadId !== workerId && !await tx.generationOf(threadId) && !await assistantReview(tx, threadId)) titled.push(threadId);
        return titled;
      });
      const unrecorded: string[] = [];
      for (const threadId of titled) {
        const kept = await formerWorkerReview(bb, threadId);
        if (kept === null || kept === targetKey) unrecorded.push(threadId);
      }
      for (const threadId of unrecorded) await recordFormerWorker(bb, threadId, targetKey, "writer");
      for (const threadId of [...(workerId ? [workerId] : []), ...unrecorded]) {
        await bb.sdk.threads.archive({ threadId }).catch(() => {});
        await bb.sdk.threads.stop({ threadId }).catch(() => {});
      }
      await restartInterruptedGuide(deps, targetKey);
    })().catch(async (error) => {
      bb.log.warn(`Could not restart the interrupted guide for ${targetKey}: ${String(error)}`);
      await interruptedGuideThrew(deps, targetKey, error).catch(() => {});
    });
  })().catch((error) => bb.log.warn(`Could not restart interrupted guides: ${String(error)}`));
  // A turn that ended while the plugin was down, or while its storage failed as BB told of it, never settled what waited
  // for it: a feedback check, a discussion, or an ask. Settled at activation, and on each review-state pass, once the
  // newest has had `grace` to start its turn, as one just asked may not have yet.
  const settleOutlivedWaits = async (grace: number) => {
    const before = Date.now() - grace;
    const asked = new Map((await store.listWaitingDiscussions()).map(({ targetKey, askedAt }) => [targetKey, askedAt]));
    for (const review of await store.listReviews()) {
      const k = review.targetKey;
      if ((review.verifyingSince || asked.has(k)) && Math.max(review.verifyingSince ?? 0, asked.get(k) ?? 0) <= before) {
        // A check that left the queue while no one heard has had its turn, or is having it.
        const threadId = review.verifyingMessageId ? await store.getAssistantThread(k) : null;
        const queue = threadId ? await bb.sdk.threads.queuedMessages.list({ threadId }).catch(() => null) : null;
        if (queue && !queue.some((m) => m.id === review.verifyingMessageId)) {
          await store.exclusive(async (tx) => { if ((await tx.getReview(k))?.verifyingMessageId === review.verifyingMessageId) await tx.setLifecycle(k, { verifyingMessageId: null }); });
        }
        if (!await assistantMayAnswer(bb, store, k) && await endAssistantWaits(bb, store, k)) await sync.evaluate(k);
      }
      // An ask whose turn ended unheard, or whose message left the queue unheard and whose turn has ended since.
      for (const { at, ask } of listAsks(review)) {
        if (ask.state === "sending" || !ask.threadId || ask.at > before || await threadMayAnswer(bb, ask.threadId)) continue;
        const withdrawn = await store.exclusive(async (tx) => {
          const current = askAt(await tx.getReview(k), at);
          if (current?.at !== ask.at || current.state !== ask.state) return false;
          await setAsk(tx, k, at, null);
          return true;
        });
        if (withdrawn) bb.realtime.publish(`review:${k}`, { ts: Date.now() });
      }
    }
  };
  void settleOutlivedWaits(0).catch((error) => bb.log.warn(`Could not settle reviews waiting on their assistants: ${String(error)}`));
  const updates = createPluginUpdates(bb, () => hasGuideGenerations(bb));
  bb.onDispose(() => { stopGuideGenerations(bb); });

  bb.log.info("code-review-workspace loaded");

  const changed = (targetKey: string) => {
    bb.realtime.publish(`review:${targetKey}`, { ts: Date.now() });
    bb.realtime.publish("reviews", { ts: Date.now() });
  };
  /** Re-read your threads on a PR now. */
  async function refreshThreads(review: ReviewMeta) {
    if (review.kind !== "pr" || !review.repo || !review.number || !baselineOf(review).at && review.ownPr !== true) return;
    const login = await sync.login();
    if (!login) return;
    const threads = await fetchMyThreads(runGh, review.repo, review.number, login, review.author ?? null);
    const threadsChanged = await store.exclusive(async (tx) => {
      // The review may have been deleted while GitHub answered.
      if (!await tx.getReview(review.targetKey)) return null;
      const threadsChanged = await tx.saveFeedbackThreads(review.targetKey, threads, (await tx.feedbackFetched(review.targetKey))?.prUpdatedAt ?? null);
      const now = (await tx.getReview(review.targetKey))!;
      await tx.setLifecycle(review.targetKey, { signals: { ...now.signals, ...threadSignals(await tx.listFeedbackThreads(review.targetKey), now.ownPr === true) } });
      return threadsChanged;
    });
    if (threadsChanged === null) return;
    // Every open review page reads the threads again when told, so it's told only when they changed.
    if (threadsChanged) bb.realtime.publish(`feedback:${review.targetKey}`, { ts: Date.now() });
  }
  /** The review's changed `files` with CODEOWNERS owners, marking yours. */
  const reviewOwners = (review: ReviewMeta, files: string[]) => codeOwners({ runGh, runGit, bb }, review, files,
    async () => ({ login: await sync.login(), teams: await sync.teams() }));

  // Each area of the server is a module (src/server-modules.ts). Registering it registers its agent tools, in this
  // order, and gives its RPC handlers, its listeners to BB's events, and the bb review subcommands it runs.
  // Who's asking in a review agent's turn. The plugin's own agents, by their recorded ids, never count as you: read from
  // configure's view and the former workers' kv, as it's asked inside the store's blocks too.
  const ownThread = async (threadId: string) => !!configured.threadRole({ id: threadId, title: null }) || await formerWorkerReview(bb, threadId) !== null;
  const moduleDeps: ServeDeps = { ...deps, receipts, submitReview, githubWrites, notifications, suggester, sync, changed, refreshThreads, reviewOwners, classify: createClassifier(bb, ownThread), fromOwnAgent: fromOwnAgent(bb, ownThread) };
  const settings = settingsRpc.register(moduleDeps);
  const reviews = reviewsRpc.register(moduleDeps);
  const githubThreads = githubThreadsRpc.register(moduleDeps);
  const draft = draftRpc.register(moduleDeps);
  const assistant = assistantRpc.register(moduleDeps);
  const turn = turnRpc.register(moduleDeps);
  patchTools.register(moduleDeps);
  draftTools.register(moduleDeps);
  feedbackTools.register(moduleDeps);
  reviewAgentTools.register(moduleDeps, { submit: draft.submit });
  const relays = relaysModule.register(moduleDeps, { submit: draft.submit });
  const events = assistantEvents.register(moduleDeps);
  guideTool.register(moduleDeps);
  const feature = featureReview.register(moduleDeps);
  const stubs = rpcStubs.register();
  const handlers: RpcHandlers = merge(settings.handlers, reviews.handlers, githubThreads.handlers, draft.handlers, assistant.handlers, turn.handlers, feature.handlers, relays.handlers, stubs.handlers);
  const guarded = Object.fromEntries(Object.entries(handlers).map(([name, handler]) =>
    [name, (input: unknown) => updates.run(() => (handler as (input: unknown) => unknown)(input))])) as unknown as typeof handlers;
  bb.rpc.register(rpcContract, {
    ...guarded,
    getReleaseStatus: () => updates.status(),
    checkPluginUpdates: () => updates.check(),
    setAutomaticUpdates: ({ enabled }) => updates.setAutomatic(enabled),
    setReviewPresence: ({ clientId, open }) => updates.presence(clientId, open),
    applyPluginUpdate: ({ clientId, candidateVersion }) => updates.apply(clientId, candidateVersion),
  });
  listen(bb, [events.events, feature.events, ledgerEvents(bb)]);
  const subcommands: Subcommands = merge(reviews.commands, draft.commands, relays.commands);

  // Tools go only to THIS plugin's own spawned threads, by the role each is recorded with: a thread can retitle
  // itself, so its title chooses only while its spawn is in flight, before its id is recorded.
  const configure = (context: PluginAgentConfigurationContext): PluginAgentConfiguration => {
    // Agents in your own threads get the skill for bb review; this plugin's threads get only what their role needs.
    // A guided-review install's threads came over with its reviews; they still get tools only by their recorded role.
    if (context.origin?.pluginId !== bb.pluginId && context.origin?.pluginId !== FORMER_PLUGIN_ID) return { tools: [], skills: configured.preferences().knobs.reviewCommandInThreads ? ["code-review-workspace"] : [] };
    const role = context.thread ? configured.threadRole(context.thread) : null;
    if (role === "writer") {
      return { tools: [...WRITER_TOOL_NAMES], skills: ["code-review-workspace-generate"] };
    }
    // The review assistant can read any file's diff on demand, so the chat
    // works across the whole review, and change its own review's local draft
    // comments — but it never gets the guide-writing tool or the generation
    // skill. Its review context arrives as instructions.
    if (role === "assistant") {
      // Its own review, never the metadata its agent can write.
      const targetKey = configured.threadReview(context.thread!);
      const review = targetKey ? configured.review(targetKey) : null;
      return {
        tools: [...ASSISTANT_TOOL_NAMES, ...(configured.preferences().knobs.reviewAgentActs ? ASSISTANT_WRITE_TOOL_NAMES : [])], skills: [],
        ...(review ? { instructions: assistantInstructions(review.targetKey, configured.guide(review.targetKey), configured.preferences(), mayRunChecks(review, configured.preferences()) ? review.number : undefined) } : {}),
      };
    }
    return { tools: [], skills: [] };
  };
  // An assistant's runtime keeps the tools it started with. Restart idle ones
  // once, so conversations from before set_review_summary get it.
  void (async () => {
    if (await bb.storage.kv.get<number>("assistant-tools") === ASSISTANT_TOOLS) return;
    await refreshAssistants(bb, store);
    await bb.storage.kv.set("assistant-tools", ASSISTANT_TOOLS);
  })().catch(() => {});

  return {
    store,
    configure,
    async run(argv, ctx) {
      return updates.run(async () => {
        // A review's own assistant or guide writer, by its recorded identity, may change only that review, as may
        // one it replaced; the Suggest instructions worker, none.
        const ownReview = (ctx.threadId ? await toolThreadReview(bb, store, ctx.threadId) ?? await formerWorkerReview(bb, ctx.threadId) : null) ?? undefined;
        // A subcommand a module runs, by its name; anything else is a PR or ref to review.
        const subcommand = Object.hasOwn(subcommands, argv[0]) ? subcommands[argv[0]] : undefined;
        return subcommand ? await subcommand(argv.slice(1), ctx, ownReview) : runReviewCommand(deps, argv, ctx, ownReview);
      });
    },
    async checkUpdates(signal) {
      while (!signal.aborted) {
        await delay(60_000, undefined, { signal }).catch(() => {});
        // Stop at once when BB stops the plugin: past 5 s it's degraded and the new instance doesn't load. What still
        // waits on the network settles unheard.
        if (!signal.aborted) await unlessAborted(updates.run(() => notifications.flush(), false), signal).catch(() => {});
        if (!signal.aborted) await unlessAborted(updates.tick(signal), signal).catch(() => {});
      }
    },
    async syncReviews(signal) {
      // On SQLite, the instance a reload replaces shares data.db, and may write after this one read configure's view,
      // which reads a guide again only when a call can change it: it's all read again once, after the first pass's first turn.
      if (sharedWithReplaced) configured.readAllAfterNextTurn();
      while (!signal.aborted) {
        await updates.run(() => sync.all(), false).catch(() => {});
        await updates.run(() => retryInterruptedGuides(deps), false).catch(() => {});
        await updates.run(() => failUnfinishedGuides(bb, store), false).catch(() => {});
        await updates.run(() => settleOutlivedWaits(WAIT_GRACE), false).catch(() => {});
        await delay(60_000, undefined, { signal }).catch(() => {});
      }
    },
    pruneOld: async () => { await pruneOldDiffs(store, Date.now()); },
  };
}
