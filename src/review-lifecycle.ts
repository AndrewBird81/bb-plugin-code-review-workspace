import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store, ReviewMeta } from "./store";
import { isMissingThread } from "./thread-errors";
import type { runGh } from "./gh";
import { ciSettled, computeTurn, type Turn, type TurnReason } from "../lib/turn";
import { alertBody, factsUpdate, threadSignals, turnOptions } from "./turn-signals";
import { completionNotifications } from "./completion-notifications";
import { matchesRepo } from "./preferences";
import { targetKey as keyFor } from "./targets";
import { fetchPrFacts } from "./github/pr-facts";
import { fetchMyThreads } from "./github/threads";
import { createNotificationGate, type NotificationGate } from "./github/notifications";
import { discoverPrs } from "./github/discovery";
import { createViewer, type Viewer } from "./github/viewer";
import type { DiscoveredPr, FeedbackThread, PrFacts, PrRead, PrRef } from "./github/types";

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
   */
  error: { kind: "auth" | "rate-limit" | "partial" | "teams" | "other"; at: number; count?: number; retryAt?: number } | null;
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
/** The account discovery last ran for; its first run only fills the list. */
const DISCOVERED = "discovery:account";
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
/** Turns that prepare their re-review ahead of time. */
const PREPARE = new Set<TurnReason>(["re-requested", "handled", "looks-ready", "dismissed"]);

/** Reconcile durable review state with GitHub, and act when a review becomes your turn. Never writes to GitHub. */
export function createReviewSync(bb: BbPluginApi, store: Store, run: typeof runGh, options: { github?: GithubReads; actions?: TurnActions; now?: () => number } = {}) {
  const github = options.github ?? githubReads(run);
  const actions = options.actions;
  const clock = options.now ?? Date.now;
  const notifications = completionNotifications(bb, store);
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
    if (!/rate.?limit/i.test(String(error))) return failed("other");
    waitUntil = clock() + RATE_LIMIT_WAIT;
    failed("rate-limit", { retryAt: waitUntil });
  };
  const limited = () => clock() < waitUntil;
  /** Who you are on GitHub; null, recording why, when gh can't say. */
  async function viewerLogin(): Promise<string | null> {
    const login = await github.viewer.login();
    if (!login) failed(AUTH_FAILED.test(github.viewer.errors?.().login ?? "") ? "auth" : "other");
    return login;
  }
  bb.onDispose(() => { disposed = true; });

  const turnOf = (review: ReviewMeta, now = clock(), options = turnOptions(store.getPreferences().preferences)) => computeTurn(review, options, now);
  // Stale alerts drop when the review is no longer your turn for the same reason.
  notifications.useTurns((key) => {
    const review = store.getReview(key);
    const turn = review && turnOf(review);
    return turn?.group === "needs" ? turn.signal : null;
  });

  // Tidies a legacy review-agent worker. Assistant threads in bb stay
  // unarchived, because an archived thread cannot take messages.
  async function maintainThread(targetKey: string) {
    const threadId = store.getAgentThread(targetKey);
    if (!threadId || disposed) return;
    try {
      if (!hidden.has(threadId)) {
        await bb.sdk.threads.update({ threadId, visibility: "hidden" });
        hidden.add(threadId);
      }
      if (store.getReview(targetKey)?.archivedAt && !archived.has(threadId) && !disposed) {
        try { await bb.sdk.threads.stop({ threadId }); }
        finally { if (!disposed) await bb.sdk.threads.archive({ threadId }); }
        archived.add(threadId);
      }
    } catch (error) {
      if (disposed) return;
      if (isMissingThread(error)) {
        // Retain the transcript, and never detach a different replacement worker.
        if (store.getAgentThread(targetKey) === threadId) store.clearAgentThread(targetKey);
      } else bb.log.warn(`Could not tidy review thread ${threadId}: ${String(error)}`);
    }
  }

  const readable = (review: ReviewMeta | null): review is ReviewMeta & { repo: string; number: number } =>
    !!review && review.kind === "pr" && !!review.repo && !!review.number && review.prState !== "MERGED";

  /** Read these reviews' PRs in batches and apply what changed. */
  async function read(keys: string[]): Promise<void> {
    const waiting = keys.filter((key) => inflight.has(key)).map((key) => inflight.get(key)!);
    const fresh = keys.filter((key) => !inflight.has(key));
    if (!fresh.length) { await Promise.allSettled(waiting); return; }
    const task = (async () => {
      if (limited()) return;
      const login = await viewerLogin();
      if (!login || disposed) return;
      const teams = await github.viewer.teams();
      const reviews = fresh.map((key) => store.getReview(key)).filter(readable);
      const startedAt = clock();
      let facts: Map<string, PrRead>;
      try {
        facts = await github.facts(reviews.map((r) => ({ targetKey: r.targetKey, repo: r.repo, number: r.number })), login, teams);
      } catch (error) {
        // A failed read preserves saved state.
        if (!disposed) { readFailed(error); bb.log.warn(`Could not refresh reviews: ${String(error)}`); }
        return;
      }
      const missing = reviews.filter((r) => !facts.has(r.targetKey)).length;
      const teamsFailed = store.getPreferences().preferences.trackTeamRequests && !!github.viewer.errors?.().teams;
      health = { lastReadAt: clock(), error: null };
      if (missing) failed("partial", { count: missing });
      else if (teamsFailed) failed("teams");
      // The list hears once per pass, however many reviews changed.
      let changed = false;
      for (const review of reviews) {
        if (disposed) return;
        checked.set(review.targetKey, clock());
        const fact = facts.get(review.targetKey);
        // Missing: GitHub couldn't be read for it; keep what's saved. Null or "forbidden": the PR is gone or out of reach.
        const done = fact === null || fact === "forbidden" ? unreachable(review.targetKey, fact ? "forbidden" : "not-found")
          : fact ? apply(review.targetKey, fact, login, startedAt) : null;
        if (await done?.catch((error) => { bb.log.warn(`Could not refresh ${review.targetKey}: ${String(error)}`); })) changed = true;
        await maintainThread(review.targetKey);
      }
      if (changed && !disposed) bb.realtime.publish("reviews", { ts: clock() });
    })().finally(() => { for (const key of fresh) if (inflight.get(key) === task) inflight.delete(key); });
    for (const key of fresh) inflight.set(key, task);
    await Promise.allSettled([task, ...waiting]);
  }

  /** Returns whether the review changed. */
  async function apply(key: string, facts: PrFacts, login: string, startedAt: number): Promise<boolean> {
    const before = store.getReview(key);
    if (!before || before.prState === "MERGED" && facts.state !== "MERGED") return false;
    // What happened before bb first read the PR is history: it shows, but doesn't alert or start work.
    const firstRead = before.watchingSince == null;
    if (firstRead) store.setLifecycle(key, { watchingSince: startedAt, watchedHead: facts.headSha });
    // Keep what the list shows current; a review found on GitHub learns its PR here.
    const meta = { title: facts.title || before.title, url: facts.url || before.url, author: facts.author ?? before.author, base: before.base ?? facts.baseRefName, head: before.head ?? facts.headRefName };
    if (meta.title !== before.title || meta.url !== before.url || meta.author !== before.author || meta.base !== before.base || meta.head !== before.head) {
      store.saveReview({ ...before, ...meta });
    }
    store.setLifecycle(key, factsUpdate(before, facts, login, startedAt, clock()));
    const updated = store.getReview(key)!;
    if (updated.signals?.lastReviewAt) {
      const fetched = store.feedbackFetched(key);
      const active = turnOf(updated).group === "needs" || turnOf(updated).group === "waiting";
      const unresolved = active && store.listFeedbackThreads(key).some((t) => !t.isResolved);
      if (!fetched || fetched.prUpdatedAt !== facts.updatedAt || unresolved && clock() - fetched.fetchedAt >= THREADS_EVERY) {
        try {
          const threads = await github.threads(facts.repo, facts.number, login, facts.author);
          // The review may have been deleted while GitHub answered.
          if (!store.getReview(key)) return false;
          store.saveFeedbackThreads(key, threads, facts.updatedAt);
          bb.realtime.publish(`feedback:${key}`, { ts: clock() });
        } catch (error) { bb.log.warn(`Could not read your threads on ${key}: ${String(error)}`); }
      }
      store.setLifecycle(key, { signals: { ...store.getReview(key)!.signals, ...threadSignals(store.listFeedbackThreads(key)) } });
    }
    await evaluate(key, firstRead);
    return changed(key, before);
  }

  /** Record that GitHub can't find the PR, or refuses access, since the first read that saw it. */
  async function unreachable(key: string, reason: "not-found" | "forbidden"): Promise<boolean> {
    const before = store.getReview(key);
    if (!before) return false;
    store.setLifecycle(key, { unreachable: { since: before.unreachable?.since ?? clock(), reason } });
    await evaluate(key);
    return changed(key, before);
  }

  /** Tell the review's page when it changed; returns whether it did. */
  function changed(key: string, before: ReviewMeta): boolean {
    if (JSON.stringify(before) === JSON.stringify(store.getReview(key))) return false;
    bb.realtime.publish(`review:${key}`, { ts: clock() });
    return true;
  }

  /** Whether an automatic re-review finished since `since`, or can't run. */
  function prepared(review: ReviewMeta, since: number): boolean {
    if (review.status === "error") return true;
    return review.status !== "generating" && (review.preparedAt ?? 0) >= since;
  }

  async function alert(key: string, turn: Turn) {
    const review = store.getReview(key)!;
    store.setLifecycle(key, { notifiedSignal: turn.signal, pendingAlert: null });
    await notifications.queueTurn({ targetKey: key, signal: turn.signal!, projectId: review.projectId ?? "", body: alertBody(review, turn) }).catch(() => {});
  }

  // One evaluation per review at a time: two could both see a new signal and prepare it twice.
  const evaluating = new Map<string, Promise<void>>();
  function evaluate(key: string, firstRead = false): Promise<void> {
    const next = (evaluating.get(key) ?? Promise.resolve()).catch(() => {}).then(() => evaluateNow(key, firstRead));
    evaluating.set(key, next);
    void next.catch(() => {}).finally(() => { if (evaluating.get(key) === next) evaluating.delete(key); });
    return next;
  }

  /**
   * Act on the review's turn: alert once per signal (after its re-review is prepared, up to
   * ALERT_WAIT), prepare re-reviews, check settled pushes, and clear the alert when it leaves Needs review.
   * Events from before bb watched the review are recorded without acting, except a new request found on GitHub.
   */
  async function evaluateNow(key: string, firstRead: boolean): Promise<void> {
    let review = store.getReview(key);
    if (!review || disposed) return;
    const now = clock();
    const preferences = store.getPreferences().preferences;
    const turn = turnOf(review, now);
    const head = review.latestHeadSha ?? review.headSha ?? null;
    // A person asking again takes the review out of your archive for good.
    if (review.userArchivedAt && turn.reason === "re-requested") store.setLifecycle(key, { userArchivedAt: null });
    if (turn.group === "needs" && turn.signal) {
      if (turn.signal !== review.notifiedSignal && turn.signal !== review.pendingAlert?.signal) {
        const watching = review.watchingSince ?? null;
        const request = turn.reason === "requested" || turn.reason === "team-requested";
        // An event from before bb watched the PR is history; one without a time is history on the first read.
        const recent = watching !== null && (turn.eventAt === null ? !firstRead : turn.eventAt >= watching);
        const act = recent || request && !!review.newRequest;
        // Handled and looks-ready come from passing states; once they're your turn, they hold until you act.
        const held = turn.reason === "handled" || turn.reason === "looks-ready" ? { heldTurn: { reason: turn.reason, label: turn.label, signal: turn.signal, at: now } } : {};
        if (!act) store.setLifecycle(key, { notifiedSignal: turn.signal, preparedSignal: turn.signal, newRequest: null, ...held });
        else {
          store.setLifecycle(key, { newRequest: null, ...held });
          const preparing = await prepare(key, turn, head);
          if (!store.getReview(key)) return;
          if (!turn.notify) store.setLifecycle(key, { notifiedSignal: turn.signal });
          else if (preparing) store.setLifecycle(key, { pendingAlert: { signal: turn.signal, since: now } });
          else await alert(key, turn);
        }
      } else if (review.preparedSignal !== turn.signal && now - (review.prepareTriedAt ?? 0) >= RETRY_PREPARE) {
        // A re-review that couldn't start (an offline machine, a GitHub hiccup) is retried now and then.
        await prepare(key, turn, head);
      }
    }
    review = store.getReview(key);
    if (!review) return;
    const waiting = review.pendingAlert;
    if (waiting) {
      const current = turnOf(review, now);
      if (current.group !== "needs" || current.signal !== waiting.signal) store.setLifecycle(key, { pendingAlert: null });
      else if (now - waiting.since >= ALERT_WAIT || prepared(review, waiting.since)) await alert(key, current);
    }
    // While you wait, the assistant checks the author's pushes once they settle; ones from before bb watched are history.
    const s = review.signals ?? {};
    if (actions && preferences.pushChecks !== "off" && turn.group === "waiting" && turn.updated && head && head !== review.watchedHead && review.status === "ready"
      && review.autoRunHead !== head && review.assessment?.headSha !== head && ciSettled(s, now) && now - (s.headSeenAt ?? now) >= PUSH_QUIET) {
      store.setLifecycle(key, { autoRunHead: head });
      if (!await actions.checkPushes(key).catch(() => false) && store.getReview(key)) store.setLifecycle(key, { autoRunHead: review.autoRunHead ?? null });
    }
    if (review.turnGroup === "needs" && turn.group !== "needs") void notifications.dismiss(key);
    if (review.turnGroup !== turn.group && store.getReview(key)) store.setLifecycle(key, { turnGroup: turn.group });
  }

  /**
   * Prepare the re-review behind a turn: rebuild an out-of-date guide and check your feedback, or
   * start the guide for a new request. Returns whether work started; a turn that needs none counts as prepared.
   */
  async function prepare(key: string, turn: Turn, head: string | null): Promise<boolean> {
    const review = store.getReview(key);
    if (!review || !turn.signal) return false;
    const preferences = store.getPreferences().preferences;
    const request = turn.reason === "requested" || turn.reason === "team-requested";
    // Guides for PRs found on GitHub cost a run each; they start only in your auto-start repositories.
    const allowed = review.status !== "tracked" || matchesRepo(preferences.autoStartRepos, review.repo);
    const wanted = PREPARE.has(turn.reason) || request && review.status === "tracked";
    if (!actions || !head || !allowed || !wanted || review.status === "generating" || review.autoRunHead === head) {
      store.setLifecycle(key, { preparedSignal: turn.signal });
      return false;
    }
    const previous = review.autoRunHead ?? null;
    store.setLifecycle(key, { autoRunHead: head, prepareTriedAt: clock() });
    const started = await (request ? actions.autoStart(key) : actions.prepare(key, turn.reason)).catch(() => false);
    if (!store.getReview(key)) return false;
    store.setLifecycle(key, started ? { preparedSignal: turn.signal } : { autoRunHead: previous });
    return started;
  }

  /**
   * Add PRs you're asked to review, or have reviewed, on GitHub. The first look for each account
   * (and after tracking is turned back on) only fills the list; later requests alert. A failure
   * recorded before `since` that a good look disproves is cleared.
   */
  async function discover(since: number): Promise<void> {
    if (!actions) return;
    if (!store.getPreferences().preferences.trackGithubReviews) {
      await bb.storage.kv.delete(DISCOVERED);
      return;
    }
    const login = await viewerLogin();
    if (!login) return;
    const found = await github.discover({ reviewed: true, teams: store.getPreferences().preferences.trackTeamRequests });
    // With nothing to read, as in an empty list, only this look shows GitHub answers again. It says nothing of PRs or teams.
    const error = health.error;
    if (error && error.at < since && (error.kind === "auth" || error.kind === "rate-limit" || error.kind === "other")) health = { ...health, error: null };
    const projectId = await actions.projectId();
    if (!projectId || disposed) return;
    const first = (await bb.storage.kv.get<{ login: string }>(DISCOVERED))?.login !== login;
    const added: string[] = [];
    // A renamed or transferred repository's PRs are already here under their old name, with their new URL.
    const urls = new Set(store.listReviews().map((r) => r.url?.toLowerCase()).filter(Boolean));
    for (const pr of found) {
      const key = keyFor({ kind: "pr", number: pr.number, repo: pr.repo });
      if (store.getReview(key) || store.isDiscoveryIgnored(key) || urls.has(pr.url.toLowerCase())) continue;
      store.saveReview({ targetKey: key, kind: "pr", number: pr.number, repo: pr.repo, title: pr.title, author: pr.author ?? undefined, url: pr.url, status: "tracked", createdAt: clock(), projectId });
      if (!first && pr.requested && !pr.reviewed) store.setLifecycle(key, { newRequest: true });
      added.push(key);
    }
    await bb.storage.kv.set(DISCOVERED, { login, at: clock() });
    if (!added.length) return;
    await read(added);
    bb.realtime.publish("reviews", { ts: clock() });
  }

  function one(targetKey: string, force = false): Promise<void> {
    if (disposed) return Promise.resolve();
    const review = store.getReview(targetKey);
    if (!readable(review)) return maintainThread(targetKey);
    if (!force && clock() - (checked.get(targetKey) ?? 0) < MINUTE) return inflight.get(targetKey) ?? Promise.resolve();
    return read([targetKey]);
  }

  async function all(force = false): Promise<void> {
    if (disposed) return;
    // `gh auth switch` outside the plugin: read as the new account, and let the panel know.
    if (await github.viewer.changed?.().catch(() => false)) {
      resetViewer();
      bb.realtime.publish("gh-account", { active: null });
    }
    // A failed check of notifications is no reason to read everything more often.
    const gate = await github.gate.poll().catch(() => ({ kind: "unchanged" as const }));
    const changed = new Set(gate.kind === "changed" ? gate.prs.map((pr) => `${pr.repo}#${pr.number}`) : []);
    const now = clock();
    // Without notifications, reviews in progress are read every minute instead.
    const interval = (group: Turn["group"]) => gate.kind === "unsupported" && (group === "needs" || group === "waiting") ? MINUTE : INTERVAL[group];
    const reviews = store.listReviews();
    // A renamed repository's PRs keep their old name here; their URL has the new one.
    const fromUrl = (url?: string) => /\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url ?? "")?.slice(1).join("#").toLowerCase();
    const due = reviews.filter(readable).filter((r) => force || changed.has(`${r.repo.toLowerCase()}#${r.number}`) || changed.has(fromUrl(r.url) ?? "")
      || now - (checked.get(r.targetKey) ?? 0) >= interval(turnOf(r, now).group));
    await read(due.map((r) => r.targetKey));
    for (const review of reviews) if (!disposed) await maintainThread(review.targetKey);
    if (!limited() && (force || now - lastDiscovery >= DISCOVER_EVERY)) {
      lastDiscovery = now;
      discovering ??= discover(now).catch((error) => { readFailed(error); bb.log.warn(`Could not look for reviews on GitHub: ${String(error)}`); }).finally(() => { discovering = null; });
      await discovering;
    }
    // Turns also change with time, such as a quiet period ending, and waiting alerts may be ready.
    const readKeys = new Set(due.map((r) => r.targetKey));
    for (const review of store.listReviews()) if (!disposed && !readKeys.has(review.targetKey)) await evaluate(review.targetKey).catch(() => {});
  }

  /** The active GitHub account changed: read who you are, your teams, your notifications, and your threads again. */
  function resetViewer() {
    github.viewer.reset();
    github.gate.reset?.();
    checked.clear();
    store.clearFeedbackFetches();
  }

  return { one, all, evaluate, turnOf, resetViewer, health: (): SyncHealth => health, login: () => github.viewer.login(), cachedLogin: () => github.viewer.cachedLogin?.() ?? null };
}
