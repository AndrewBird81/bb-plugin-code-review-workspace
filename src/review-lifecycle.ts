import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewMeta } from "./store";
import { isMissingThread } from "./thread-errors";
import type { runGh } from "./gh";
import { baselineOf, ciSettled, computeTurn, type Turn, type TurnOptions, type TurnReason } from "../lib/turn";
import { alertBody, factsUpdate, threadSignals, turnOptions } from "./turn-signals";
import { completionNotifications } from "./completion-notifications";
import { matchesRepo, reReviewCheckPrompt } from "./preferences";
import { mayRunUnattended, skipWhy } from "../lib/trust";
import { targetKey as keyFor } from "./targets";
import { BATCH_SIZE, fetchPrFacts } from "./github/pr-facts";
import { guideBehind } from "./feedback-view";
import { fetchMyThreads } from "./github/threads";
import { createNotificationGate, type NotificationGate } from "./github/notifications";
import { discoverPrs } from "./github/discovery";
import { createViewer, type Viewer } from "./github/viewer";
import type { DiscoveredPr, FeedbackThread, PrFacts, PrRead, PrRef } from "./github/types";
import type { AsyncStore } from "./store-queue";

/** Everything the sync reads from GitHub. */
export interface GithubReads {
  viewer: Viewer;
  gate: NotificationGate;
  facts(refs: PrRef[], viewer: string, teams: ReadonlySet<string>): Promise<Map<string, PrRead>>;
  threads(repo: string, number: number, viewer: string, author: string | null): Promise<FeedbackThread[]>;
  discover(options: { reviewed: boolean; teams: boolean }): Promise<DiscoveredPr[]>;
}

export function githubReads(run: typeof runGh): GithubReads {
  return {
    viewer: createViewer(run), gate: createNotificationGate(run),
    facts: (refs, viewer, teams) => fetchPrFacts(run, refs, viewer, teams),
    threads: (repo, number, viewer, author) => fetchMyThreads(run, repo, number, viewer, author),
    discover: (options) => discoverPrs(run, options),
  };
}

/** How reading GitHub went: when it last read PRs, and what went wrong since, if anything. */
export interface SyncHealth {
  lastReadAt: number | null;
  /**
   * auth: gh isn't signed in or its token was refused. rate-limit: reading waits until retryAt.
   * partial: `count` PRs couldn't be read. teams: your teams couldn't be read, so team requests may be missing.
   * gh-missing: gh couldn't start on the BB server.
   */
  error: { kind: "auth" | "rate-limit" | "partial" | "teams" | "gh-missing" | "other"; at: number; count?: number; retryAt?: number } | null;
}

/** What the plugin does when a review's turn changes. Each returns whether work started. */
export interface TurnActions {
  /** A re-review came back to you: regenerate an out-of-date guide, then check your feedback. */
  prepare(targetKey: string, reason: TurnReason): Promise<boolean>;
  /** The author's pushes settled while you wait: check your feedback against them. */
  checkPushes(targetKey: string): Promise<boolean>;
  /** Your review was requested in an auto-start repository: generate the guide. */
  autoStart(targetKey: string): Promise<boolean>;
  /** The project reviews found on GitHub run in. */
  projectId(): Promise<string | null>;
}

const MINUTE = 60_000;
/** How often each group is read from GitHub without a notification saying it changed. */
const INTERVAL: Record<Turn["group"], number> = { needs: 2 * MINUTE, waiting: 2 * MINUTE, reviewed: 10 * MINUTE, archive: 30 * MINUTE };
/** How long an alert waits for its re-review to be prepared. */
const ALERT_WAIT = 10 * MINUTE;
/** How long pushes must settle before the assistant checks them. */
const PUSH_QUIET = 15 * MINUTE;
const DISCOVER_EVERY = 5 * MINUTE;
/** The account discovery last ran for, and whether it looked for team requests; its first run only fills the list. */
const DISCOVERED = "discovery:account";
/** Raise when the turn rules change what counts as an event (0.5.0: non-blocking threads, mentions, CI that never reports). */
const TURN_RULES = 5;
/**
 * Threads are re-read when the PR changes, and at least this often while it's active and one of yours is
 * unresolved: resolving a thread may not change the PR's updatedAt. Each read costs about 2 GraphQL points.
 */
const THREADS_EVERY = 10 * MINUTE;
/** How often a re-review that couldn't start is tried again. */
const RETRY_PREPARE = 10 * MINUTE;
/** How long reading waits after GitHub's rate limit. */
const RATE_LIMIT_WAIT = 15 * MINUTE;
/** What gh or GitHub says when gh isn't signed in or its token was refused. */
const AUTH_FAILED = /gh auth login|HTTP 401|Bad credentials/i;
/** What runGh says when gh can't be spawned, as when it isn't installed (src/gh.ts). */
const GH_MISSING = /\bgh could not start\b/;
/** Turns that prepare their re-review ahead of time. */
const PREPARE = new Set<TurnReason>(["re-requested", "handled", "looks-ready", "dismissed"]);

/** Reconcile durable review state with GitHub, and act when a review becomes your turn. Never writes to GitHub. */
export function createReviewSync(bb: BbPluginApi, store: AsyncStore, run: typeof runGh, options: { github?: GithubReads; actions?: TurnActions; now?: () => number } = {}) {
  const github = options.github ?? githubReads(run);
  const actions = options.actions;
  const clock = options.now ?? Date.now;
  const notifications = completionNotifications(bb, store);
  /** Each review being read, until its read is applied. */
  const inflight = new Map<string, Promise<void>>();
  const checked = new Map<string, number>();
  const hidden = new Set<string>();
  const archived = new Set<string>();
  let lastDiscovery = 0;
  let discovering: Promise<void> | null = null;
  let disposed = false;
  let health: SyncHealth = { lastReadAt: null, error: null };
  let waitUntil = 0;
  const failed = (kind: NonNullable<SyncHealth["error"]>["kind"], extra: { count?: number; retryAt?: number } = {}) => {
    health = { ...health, error: { kind, at: clock(), ...extra } };
  };
  /** Record a failed read; a rate limit stops reading for a while. */
  const readFailed = (error: unknown) => {
    // The login stays cached for an hour, so a revoked token shows first in the reads.
    if (AUTH_FAILED.test(String(error))) return failed("auth");
    if (GH_MISSING.test(String(error))) return failed("gh-missing");
    if (!/rate.?limit/i.test(String(error))) return failed("other");
    waitUntil = clock() + RATE_LIMIT_WAIT;
    failed("rate-limit", { retryAt: waitUntil });
  };
  const limited = () => clock() < waitUntil;
  /** Who you are on GitHub; null, recording why, when gh can't say. */
  async function viewerLogin(): Promise<string | null> {
    const login = await github.viewer.login();
    const why = github.viewer.errors?.().login ?? "";
    if (!login) failed(AUTH_FAILED.test(why) ? "auth" : GH_MISSING.test(why) ? "gh-missing" : "other");
    return login;
  }
  bb.onDispose(() => { disposed = true; });
  // New turn rules can make events read before them a new turn; like the time before bb watched a PR, they're history.
  let rulesUpgraded: Promise<void> | null = null;
  const upgradeRules = () => rulesUpgraded ??= (async () => {
    if (await bb.storage.kv.get<number>("turn-rules") === TURN_RULES) return;
    const at = clock();
    await store.exclusive(async (tx) => {
      for (const review of await tx.listReviews()) {
        if (review.watchingSince != null) await tx.setLifecycle(review.targetKey, { watchingSince: at, watchedHead: review.latestHeadSha ?? review.headSha ?? null });
      }
    });
    await bb.storage.kv.set("turn-rules", TURN_RULES);
  })().catch((error) => bb.log.warn(`Could not start the new turn rules: ${String(error)}`));

  const turnOf = async (review: ReviewMeta, now = clock(), options?: ReturnType<typeof turnOptions>) => computeTurn(review, options ?? turnOptions((await store.getPreferences()).preferences), now);
  // Stale alerts drop when the review is no longer your turn for the same reason. The outbox asks inside its block.
  notifications.useTurns(async (tx, key) => {
    const review = await tx.getReview(key);
    const turn = review && await turnOf(review, undefined, turnOptions((await tx.getPreferences()).preferences));
    return turn?.group === "needs" ? turn.signal : null;
  });

  // Tidies a legacy review-agent worker. Assistant threads in bb stay
  // unarchived, because an archived thread cannot take messages.
  async function maintainThread(targetKey: string) {
    const threadId = await store.getAgentThread(targetKey);
    if (!threadId || disposed) return;
    try {
      if (!hidden.has(threadId)) {
        await bb.sdk.threads.update({ threadId, visibility: "hidden" });
        hidden.add(threadId);
      }
      if ((await store.getReview(targetKey))?.archivedAt && !archived.has(threadId) && !disposed) {
        try { await bb.sdk.threads.stop({ threadId }); }
        finally { if (!disposed) await bb.sdk.threads.archive({ threadId }); }
        archived.add(threadId);
      }
    } catch (error) {
      if (disposed) return;
      if (isMissingThread(error)) {
        // Retain the transcript, and never detach a different replacement worker.
        await store.exclusive(async (tx) => {
          if (await tx.getAgentThread(targetKey) === threadId) await tx.clearAgentThread(targetKey);
        });
      } else bb.log.warn(`Could not tidy review thread ${threadId}: ${String(error)}`);
    }
  }

  const readable = (review: ReviewMeta | null): review is ReviewMeta & { repo: string; number: number } =>
    !!review && review.kind === "pr" && !!review.repo && !!review.number && review.prState !== "MERGED";

  /**
   * Read these reviews' PRs in batches and apply what changed. `pass`: a sync pass, whose read speaks for every review.
   * Each review's read settles once its own batch is applied, so a read of one that joins a pass doesn't wait for the rest.
   */
  async function read(keys: string[], pass = false): Promise<void> {
    const waiting = keys.filter((key) => inflight.has(key)).map((key) => inflight.get(key)!);
    const fresh = keys.filter((key) => !inflight.has(key));
    if (!fresh.length) { await Promise.allSettled(waiting); return; }
    const settle = new Map<string, () => void>();
    const mine = new Map(fresh.map((key) => [key, new Promise<void>((resolve) => settle.set(key, resolve))]));
    const settled = (key: string) => {
      settle.get(key)?.();
      if (inflight.get(key) === mine.get(key)) inflight.delete(key);
    };
    for (const [key, promise] of mine) inflight.set(key, promise);
    const task = (async () => {
      await upgradeRules();
      if (limited()) return;
      const login = await viewerLogin();
      if (!login || disposed) return;
      const teams = await github.viewer.teams();
      const reviews = (await store.exclusive(async (tx) => {
        const found = [];
        for (const key of fresh) found.push(await tx.getReview(key));
        return found;
      })).filter(readable);
      // The list hears once per pass, however many reviews changed.
      let changed = false;
      let missing = 0;
      let read = 0;
      let failure: unknown = null;
      const unread: string[] = [];
      for (let i = 0; i < reviews.length; i += BATCH_SIZE) {
        if (disposed) return;
        const batch = reviews.slice(i, i + BATCH_SIZE);
        const startedAt = clock();
        let facts: Map<string, PrRead>;
        try {
          facts = await github.facts(batch.map((r) => ({ targetKey: r.targetKey, repo: r.repo, number: r.number })), login, teams);
          read++;
        } catch (error) {
          // A failed read preserves saved state.
          failure = error;
          missing += batch.length;
          for (const review of batch) { unread.push(review.targetKey); settled(review.targetKey); }
          continue;
        }
        for (const review of batch) {
          if (disposed) return;
          checked.set(review.targetKey, clock());
          const fact = facts.get(review.targetKey);
          if (fact === undefined) missing++;
          // Missing: GitHub couldn't be read for it; keep what's saved. Null or "forbidden": the PR is gone or out of reach.
          const done = fact === null || fact === "forbidden" ? unreachable(review.targetKey, fact ? "forbidden" : "not-found")
            : fact ? apply(review.targetKey, fact, login, startedAt) : null;
          if (await done?.catch((error) => { bb.log.warn(`Could not refresh ${review.targetKey}: ${String(error)}`); })) changed = true;
          await maintainThread(review.targetKey);
          settled(review.targetKey);
        }
      }
      if (disposed) return;
      if (failure && !read) {
        readFailed(failure);
        bb.log.warn(`Could not refresh reviews: ${String(failure)}`);
        return;
      }
      // Once GitHub answers, a batch it failed waits for its next turn like the rest.
      for (const key of unread) checked.set(key, clock());
      const teamsFailed = (await store.getPreferences()).preferences.trackTeamRequests && !!github.viewer.errors?.().teams;
      // Any good read shows gh runs and GitHub answers again; only a pass says whether every PR and your teams could be read.
      const kept = pass ? null : health.error?.kind === "partial" || health.error?.kind === "teams" ? health.error : null;
      health = { lastReadAt: clock(), error: kept };
      if (!kept && missing) failed("partial", { count: missing });
      else if (!kept && teamsFailed) failed("teams");
      if (changed) bb.realtime.publish("reviews", { ts: clock() });
    })().finally(() => { for (const key of fresh) settled(key); });
    await Promise.allSettled([task, ...waiting]);
  }

  /** Returns whether the review changed. */
  async function apply(key: string, facts: PrFacts, login: string, startedAt: number): Promise<boolean> {
    /** The review's signals from your threads, as saved now. */
    const threadsSignals = async (tx: AsyncStore) => {
      await tx.setLifecycle(key, { signals: { ...(await tx.getReview(key))!.signals, ...threadSignals(await tx.listFeedbackThreads(key)) } });
    };
    // What GitHub said, recorded in one turn; your threads, when they need reading, in the turn after GitHub answers.
    const read = await store.exclusive(async (tx) => {
      const before = await tx.getReview(key);
      if (!before || before.prState === "MERGED" && facts.state !== "MERGED") return null;
      // What happened before bb first read the PR is history: it shows, but doesn't alert or start work.
      const firstRead = before.watchingSince == null;
      if (firstRead) await tx.setLifecycle(key, { watchingSince: startedAt, watchedHead: facts.headSha });
      // Keep what the list shows current; a review found on GitHub learns its PR here.
      const meta = { title: facts.title || before.title, url: facts.url || before.url, author: facts.author ?? before.author, base: before.base ?? facts.baseRefName, head: before.head ?? facts.headRefName };
      if (meta.title !== before.title || meta.url !== before.url || meta.author !== before.author || meta.base !== before.base || meta.head !== before.head) {
        await tx.saveReview({ ...before, ...meta });
      }
      await tx.setLifecycle(key, factsUpdate(before, facts, login, startedAt, clock()));
      const updated = (await tx.getReview(key))!;
      // Once you've reviewed, here or as GitHub last said, as refreshThreads reads them.
      if (!baselineOf(updated).at) return { before, firstRead, threads: false };
      const fetched = await tx.feedbackFetched(key);
      const { group } = await turnOf(updated, undefined, turnOptions((await tx.getPreferences()).preferences));
      const active = group === "needs" || group === "waiting";
      const unresolved = active && (await tx.listFeedbackThreads(key)).some((t) => !t.isResolved);
      if (!fetched || fetched.prUpdatedAt !== facts.updatedAt || unresolved && clock() - fetched.fetchedAt >= THREADS_EVERY) return { before, firstRead, threads: true };
      await threadsSignals(tx);
      return { before, firstRead, threads: false };
    });
    if (!read) return false;
    if (read.threads) {
      const warn = (error: unknown) => bb.log.warn(`Could not read your threads on ${key}: ${String(error)}`);
      let threads: Awaited<ReturnType<typeof github.threads>> | null = null;
      try { threads = await github.threads(facts.repo, facts.number, login, facts.author); } catch (error) { warn(error); }
      const gone = await store.exclusive(async (tx) => {
        if (threads) try {
          // The review may have been deleted while GitHub answered.
          if (!await tx.getReview(key)) return true;
          // Every open review page reads the threads again when told, so it's told only when they changed.
          if (await tx.saveFeedbackThreads(key, threads, facts.updatedAt)) bb.realtime.publish(`feedback:${key}`, { ts: clock() });
        } catch (error) { warn(error); }
        await threadsSignals(tx);
        return false;
      });
      if (gone) return false;
    }
    await evaluate(key, read.firstRead);
    return await changed(key, read.before);
  }

  /** Record that GitHub can't find the PR, or refuses access, since the first read that saw it. */
  async function unreachable(key: string, reason: "not-found" | "forbidden"): Promise<boolean> {
    const before = await store.exclusive(async (tx) => {
      const before = await tx.getReview(key);
      if (before) await tx.setLifecycle(key, { unreachable: { since: before.unreachable?.since ?? clock(), reason } });
      return before;
    });
    if (!before) return false;
    await evaluate(key);
    return await changed(key, before);
  }

  /** Tell the review's page when it changed; returns whether it did. */
  async function changed(key: string, before: ReviewMeta): Promise<boolean> {
    if (JSON.stringify(before) === JSON.stringify(await store.getReview(key))) return false;
    bb.realtime.publish(`review:${key}`, { ts: clock() });
    return true;
  }

  /** Whether an automatic re-review finished since `since`, or can't run. */
  function prepared(review: ReviewMeta, since: number): boolean {
    if (review.status === "error") return true;
    return review.status !== "generating" && (review.preparedAt ?? 0) >= since;
  }

  /**
   * Alert of the turn: recorded in the caller's block, `tx`, which returns what to send once it has ended (sendAlert).
   * `woke`: the time a snooze that held this turn ended, whose alert is an event of its own.
   */
  async function beginAlert(tx: AsyncStore, key: string, turn: Turn, woke: number | null = null) {
    const review = (await tx.getReview(key))!;
    await tx.setLifecycle(key, { notifiedSignal: turn.signal, pendingAlert: null });
    const eventId = woke != null ? `turn:${turn.signal}:woke:${woke}` : undefined;
    return { targetKey: key, signal: turn.signal!, eventId, projectId: review.projectId ?? "", body: alertBody(review, turn) };
  }
  const sendAlert = (alert: Awaited<ReturnType<typeof beginAlert>>) => notifications.queueTurn(alert).catch(() => {});

  // One evaluation per review at a time: two could both see a new signal and prepare it twice.
  const evaluating = new Map<string, Promise<void>>();
  function serialized(key: string, work: () => Promise<void> | void): Promise<void> {
    const next = (evaluating.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    evaluating.set(key, next);
    void next.catch(() => {}).finally(() => { if (evaluating.get(key) === next) evaluating.delete(key); });
    return next;
  }
  const evaluate = (key: string, firstRead = false) => serialized(key, () => evaluateNow(key, firstRead));

  /**
   * You opened the review: an alert waiting for its re-review to be prepared is seen, so it doesn't come once
   * that's done. Only the turn's current signal; after any evaluation in progress, which may be about to queue it.
   */
  const seen = (key: string) => serialized(key, async () => {
    return store.exclusive(async (tx) => {
      const review = await tx.getReview(key);
      const waiting = review?.pendingAlert;
      if (!review || !waiting) return;
      const turn = await turnOf(review, undefined, turnOptions((await tx.getPreferences()).preferences));
      if (turn.group === "needs" && turn.signal === waiting.signal) await tx.setLifecycle(key, { notifiedSignal: waiting.signal, pendingAlert: null });
    });
  });

  /**
   * Act on the review's turn: alert once per signal (after its re-review is prepared, up to
   * ALERT_WAIT), prepare re-reviews, check settled pushes, and clear the alert when it leaves Needs review.
   * Events from before bb watched the review are recorded without acting, except a new request found on GitHub.
   */
  async function evaluateNow(key: string, firstRead: boolean): Promise<void> {
    await upgradeRules();
    const now = clock();
    // The turn, and what it records and begins, in one turn of the queue; the work it begins follows that turn.
    const first = await store.exclusive(async (tx) => {
      let review = await tx.getReview(key);
      if (!review || disposed) return null;
      const preferences = (await tx.getPreferences()).preferences;
      const options = turnOptions(preferences);
      // A snooze until a time ends then. The turn it set aside alerts again, once; one that woke it earlier has alerted.
      let woke: number | null = null;
      if (review.snoozedUntil != null && now >= review.snoozedUntil) {
        const held = (await turnOf(review, review.snoozedUntil - 1, options)).reason === "snoozed";
        if (held) woke = review.snoozedUntil;
        await tx.setLifecycle(key, { snoozedAt: null, snoozedUntil: null, ...(held ? { notifiedSignal: null, pendingAlert: null } : {}) });
        review = (await tx.getReview(key))!;
      }
      const turn = await turnOf(review, now, options);
      const head = review.latestHeadSha ?? review.headSha ?? null;
      // A person asking again takes the review out of your archive for good.
      if (review.userArchivedAt && turn.reason === "re-requested") await tx.setLifecycle(key, { userArchivedAt: null });
      /** The re-review it prepares, and whether its alert follows it. */
      let preparing: { work: PrepareWork | null; alerts: boolean } | null = null;
      if (turn.group === "needs" && turn.signal) {
        if (turn.signal !== review.notifiedSignal && turn.signal !== review.pendingAlert?.signal) {
          const watching = review.watchingSince ?? null;
          const request = turn.reason === "requested" || turn.reason === "team-requested";
          // An event from before bb watched the PR is history; one without a time is history on the first read.
          const recent = watching !== null && (turn.eventAt === null ? !firstRead : turn.eventAt >= watching);
          const act = recent || request && !!review.newRequest;
          // Handled and looks-ready come from passing states; once they're your turn, they hold until you act.
          const held = turn.reason === "handled" || turn.reason === "looks-ready" ? { heldTurn: { reason: turn.reason, label: turn.label, signal: turn.signal, at: now } } : {};
          if (!act) await tx.setLifecycle(key, { notifiedSignal: turn.signal, preparedSignal: turn.signal, newRequest: null, ...held });
          else {
            await tx.setLifecycle(key, { newRequest: null, ...held });
            preparing = { work: await beginPrepare(tx, key, turn, head), alerts: true };
          }
        } else if (review.preparedSignal !== turn.signal && now - (review.prepareTriedAt ?? 0) >= RETRY_PREPARE) {
          // A re-review that couldn't start (an offline machine, a GitHub hiccup) is retried now and then.
          preparing = { work: await beginPrepare(tx, key, turn, head), alerts: false };
        }
      }
      return { preferences, turn, head, woke, preparing };
    });
    if (!first) return;
    const { preferences, turn, head, woke, preparing } = first;
    if (preparing) {
      const started = preparing.work ? await finishPrepare(key, turn, preparing.work) : false;
      if (preparing.alerts) {
        const alert = await store.exclusive(async (tx) => {
          if (!await tx.getReview(key)) return "gone";
          if (!turn.notify) await tx.setLifecycle(key, { notifiedSignal: turn.signal });
          else if (started) await tx.setLifecycle(key, { pendingAlert: { signal: turn.signal!, since: now } });
          else return await beginAlert(tx, key, turn, woke);
          return null;
        });
        if (alert === "gone") return;
        if (alert) await sendAlert(alert);
      }
    }
    /**
     * While you wait, the assistant checks the author's pushes once they settle; ones from before bb watched are history.
     * A check that's turned off has nothing to run; one that couldn't start is retried now and then. Recorded in the
     * caller's block; returns whether to check them once it has ended.
     */
    const pushes = async (tx: AsyncStore, review: ReviewMeta) => {
      const s = review.signals ?? {};
      if (!(actions && preferences.pushChecks !== "off" && reReviewCheckPrompt(preferences) && turn.group === "waiting" && turn.updated && head && head !== review.watchedHead && review.status === "ready"
        && review.autoRunHead !== head && review.assessment?.headSha !== head && ciSettled(s, now) && now - (s.headSeenAt ?? now) >= PUSH_QUIET
        && now - (review.pushCheckTriedAt ?? 0) >= RETRY_PREPARE)) return false;
      // An untrusted author's pushes wait for your click.
      if (!mayRunUnattended(review, preferences, head)) {
        await tx.setLifecycle(key, { autoRunHead: head, skippedRun: { run: "check", head, at: now, ...skipWhy(review, preferences) } });
        return false;
      }
      await tx.setLifecycle(key, { autoRunHead: head, pushCheckTriedAt: now });
      return true;
    };
    /** The group the review is in now, recorded in the caller's block; leaving Needs review clears its alert. */
    const regroup = async (tx: AsyncStore, review: ReviewMeta) => {
      if (review.turnGroup === "needs" && turn.group !== "needs") void notifications.dismiss(key).catch((error) => bb.log.warn(`Could not dismiss the Needs You alert of ${key}: ${String(error)}`));
      if (review.turnGroup !== turn.group && await tx.getReview(key)) await tx.setLifecycle(key, { turnGroup: turn.group });
    };
    // An alert waiting for its re-review, the pushes to check, and the group, in one turn, unless the alert goes first.
    const then = await store.exclusive(async (tx) => {
      const review = await tx.getReview(key);
      if (!review) return null;
      const waiting = review.pendingAlert;
      if (waiting) {
        const current = await turnOf(review, now, turnOptions((await tx.getPreferences()).preferences));
        if (current.group !== "needs" || current.signal !== waiting.signal) await tx.setLifecycle(key, { pendingAlert: null });
        else if (now - waiting.since >= ALERT_WAIT || prepared(review, waiting.since)) return { review, alert: await beginAlert(tx, key, current), checking: false };
      }
      const checking = await pushes(tx, review);
      if (!checking) await regroup(tx, review);
      return { review, alert: null, checking };
    });
    if (!then) return;
    const { review } = then;
    let checking = then.checking;
    if (then.alert) {
      await sendAlert(then.alert);
      checking = await store.exclusive(async (tx) => {
        const checking = await pushes(tx, review);
        if (!checking) await regroup(tx, review);
        return checking;
      });
    }
    if (checking) {
      const checked = await actions!.checkPushes(key).catch(() => false);
      await store.exclusive(async (tx) => {
        if (!checked && await tx.getReview(key)) await tx.setLifecycle(key, { autoRunHead: review.autoRunHead ?? null });
        await regroup(tx, review);
      });
    }
  }

  /** The re-review work prepare begins, and the push it started at, to put back if the work doesn't start. */
  type PrepareWork = { start: () => Promise<boolean>; previous: string | null };
  /**
   * Prepare the re-review behind a turn, in the caller's block, `tx`: rebuild an out-of-date guide and check your
   * feedback, or start the guide for a new request. Returns the work to start once the block has ended (finishPrepare),
   * or null when it needs none, which counts as prepared, or can't start without your click.
   */
  async function beginPrepare(tx: AsyncStore, key: string, turn: Turn, head: string | null): Promise<PrepareWork | null> {
    const review = await tx.getReview(key);
    if (!review || !turn.signal) return null;
    const preferences = (await tx.getPreferences()).preferences;
    const request = turn.reason === "requested" || turn.reason === "team-requested";
    // Guides for PRs found on GitHub cost a run each; they start only in your auto-start repositories.
    const allowed = review.status !== "tracked" || matchesRepo(preferences.autoStartRepos, review.repo);
    // Off in Settings, a re-review alerts at once; a request still starts its guide in your auto-start repositories.
    const wanted = PREPARE.has(turn.reason) && preferences.knobs.prepareOnReturn || request && review.status === "tracked";
    if (!actions || !head || !allowed || !wanted || review.status === "generating" || review.autoRunHead === head) {
      await tx.setLifecycle(key, { preparedSignal: turn.signal });
      return null;
    }
    // An untrusted author's text reaches agents only after your click; the review says what didn't run.
    if (!mayRunUnattended(review, preferences, head)) {
      // A check that's turned off wouldn't have run; the guide behind it still needed rebuilding.
      const check = !!reReviewCheckPrompt(preferences);
      const skipped = request || review.status === "tracked" || guideBehind(review) || check;
      await tx.setLifecycle(key, { preparedSignal: turn.signal, ...(skipped ? { skippedRun: { run: request || !check ? "guide" : "check", head, at: clock(), ...skipWhy(review, preferences) } } : {}) });
      return null;
    }
    await tx.setLifecycle(key, { autoRunHead: head, prepareTriedAt: clock() });
    return { start: () => (request ? actions.autoStart(key) : actions.prepare(key, turn.reason)).catch(() => false), previous: review.autoRunHead ?? null };
  }

  /** Start the work beginPrepare began, and record whether it started. Returns whether it did. */
  async function finishPrepare(key: string, turn: Turn, work: PrepareWork): Promise<boolean> {
    const started = await work.start();
    return store.exclusive(async (tx) => {
      if (!await tx.getReview(key)) return false;
      await tx.setLifecycle(key, started ? { preparedSignal: turn.signal } : { autoRunHead: work.previous });
      return started;
    });
  }

  /**
   * Add PRs you're asked to review, or have reviewed, on GitHub. The first look for each account
   * (and after tracking is turned back on) only fills the list, as does a look whose search widened;
   * later requests alert. A failure
   * recorded before `since` that a good look disproves is cleared.
   */
  async function discover(since: number): Promise<void> {
    if (!actions) return;
    if (!(await store.getPreferences()).preferences.trackGithubReviews) {
      await bb.storage.kv.delete(DISCOVERED);
      return;
    }
    const login = await viewerLogin();
    if (!login) return;
    const { knobs, trackTeamRequests } = (await store.getPreferences()).preferences;
    const found = await github.discover({ reviewed: knobs.trackReviewedPrs, teams: trackTeamRequests });
    // With nothing to read, as in an empty list, only this look shows GitHub answers again. It says nothing of PRs or teams.
    const error = health.error;
    if (error && error.at < since && (error.kind === "auth" || error.kind === "rate-limit" || error.kind === "gh-missing" || error.kind === "other")) health = { ...health, error: null };
    const projectId = await actions.projectId();
    if (!projectId || disposed) return;
    const last = await bb.storage.kv.get<{ login: string; teams?: boolean }>(DISCOVERED);
    const first = last?.login !== login;
    // Team requests come from the same search as yours, so the look that first includes them adds no new request.
    // PRs you've reviewed come from a search of their own, and never count as new requests.
    const widened = trackTeamRequests && last?.teams === false;
    // A renamed or transferred repository's PRs are already here under their old name, with their new URL.
    const urlsNow = async (tx: AsyncStore) => new Set((await tx.listReviews()).map((r) => r.url?.toLowerCase()).filter(Boolean));
    const known = async (tx: AsyncStore, urls: Set<string | undefined>, pr: DiscoveredPr) => {
      const key = keyFor({ kind: "pr", number: pr.number, repo: pr.repo });
      return !!await tx.getReview(key) || await tx.isDiscoveryIgnored(key) || urls.has(pr.url.toLowerCase());
    };
    /** Each PR found that isn't here yet, added in the caller's block. */
    const add = async (tx: AsyncStore, urls: Set<string | undefined>) => {
      const added: string[] = [];
      for (const pr of found) {
        const key = keyFor({ kind: "pr", number: pr.number, repo: pr.repo });
        if (await known(tx, urls, pr)) continue;
        await tx.saveReview({ targetKey: key, kind: "pr", number: pr.number, repo: pr.repo, title: pr.title, author: pr.author ?? undefined, url: pr.url, status: "tracked", createdAt: clock(), projectId });
        if (!first && !widened && pr.requested && !pr.reviewed) await tx.setLifecycle(key, { newRequest: true });
        added.push(key);
      }
      return added;
    };
    // What's known, and what's added, in one turn, unless namesakes are read in between.
    const looked = await store.exclusive(async (tx) => {
      const urls = await urlsNow(tx);
      // One that no read has told its new URL yet is read first: a review of the same number in another repository.
      const unknown: DiscoveredPr[] = [];
      for (const pr of found) if (!await known(tx, urls, pr)) unknown.push(pr);
      const namesakes = (await tx.listReviews()).filter(readable)
        .filter((r) => unknown.some((pr) => pr.number === r.number && pr.repo.toLowerCase() !== r.repo.toLowerCase()));
      return namesakes.length ? { namesakes } : { added: await add(tx, urls) };
    });
    let added = looked.added;
    if (looked.namesakes) {
      await read(looked.namesakes.map((r) => r.targetKey));
      if (disposed) return;
      added = await store.exclusive(async (tx) => await add(tx, await urlsNow(tx)));
    }
    await bb.storage.kv.set(DISCOVERED, { login, at: clock(), teams: trackTeamRequests });
    if (!added?.length) return;
    await read(added);
    bb.realtime.publish("reviews", { ts: clock() });
  }

  async function one(targetKey: string, force = false): Promise<void> {
    if (disposed) return Promise.resolve();
    const review = await store.getReview(targetKey);
    if (!readable(review)) return maintainThread(targetKey);
    if (!force && clock() - (checked.get(targetKey) ?? 0) < MINUTE) return inflight.get(targetKey) ?? Promise.resolve();
    return read([targetKey]);
  }

  async function all(force = false): Promise<void> {
    if (disposed) return;
    // `gh auth switch` outside the plugin: read as the new account, and let the panel know.
    if (await github.viewer.changed?.().catch(() => false)) {
      await resetViewer();
      bb.realtime.publish("gh-account", { active: null });
    }
    // A failed check of notifications is no reason to read everything more often.
    const gate = await github.gate.poll().catch(() => ({ kind: "unchanged" as const }));
    const changed = new Set(gate.kind === "changed" ? gate.prs.map((pr) => `${pr.repo}#${pr.number}`) : []);
    const now = clock();
    // Without notifications, reviews in progress are read every minute instead.
    const interval = (group: Turn["group"]) => gate.kind === "unsupported" && (group === "needs" || group === "waiting") ? MINUTE : INTERVAL[group];
    // A renamed repository's PRs keep their old name here; their URL has the new one.
    const fromUrl = (url?: string) => /\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url ?? "")?.slice(1).join("#").toLowerCase();
    // The reviews, and whose turn each is, in one turn.
    const { reviews, due } = await store.exclusive(async (tx) => {
      const reviews = await tx.listReviews();
      let options: TurnOptions | undefined;
      const due: ReviewMeta[] = [];
      for (const r of reviews.filter(readable)) {
        if (force || changed.has(`${r.repo.toLowerCase()}#${r.number}`) || changed.has(fromUrl(r.url) ?? "")
          || now - (checked.get(r.targetKey) ?? 0) >= interval((await turnOf(r, now, options ??= turnOptions((await tx.getPreferences()).preferences))).group)) due.push(r);
      }
      return { reviews, due };
    });
    await read(due.map((r) => r.targetKey), true);
    for (const review of reviews) if (!disposed) await maintainThread(review.targetKey);
    if (!limited() && (force || now - lastDiscovery >= DISCOVER_EVERY)) {
      lastDiscovery = now;
      discovering ??= discover(now).catch((error) => { readFailed(error); bb.log.warn(`Could not look for reviews on GitHub: ${String(error)}`); }).finally(() => { discovering = null; });
      await discovering;
    }
    // Turns also change with time, such as a quiet period ending, and waiting alerts may be ready.
    const readKeys = new Set(due.map((r) => r.targetKey));
    for (const review of await store.listReviews()) if (!disposed && !readKeys.has(review.targetKey)) await evaluate(review.targetKey).catch(() => {});
  }

  /** The active GitHub account changed: read who you are, your teams, your notifications, and your threads again. */
  async function resetViewer() {
    github.viewer.reset();
    github.gate.reset?.();
    checked.clear();
    await store.clearFeedbackFetches();
  }

  return { one, all, evaluate, seen, turnOf, resetViewer, health: (): SyncHealth => health, login: () => github.viewer.login(), teams: () => github.viewer.teams(), cachedLogin: () => github.viewer.cachedLogin?.() ?? null };
}
