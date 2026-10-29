// Your PR's review threads on GitHub: reading them, and replying, resolving and unresolving as the account the page verified.
import { ghReviewThreadsArgs, ghReplyThreadArgs, ghResolveThreadArgs, ghUnresolveThreadArgs, runGh, ghErrorMessage } from "./gh";
import { postDraftedReply } from "./post-receipts";
import { parseReviewThreads } from "./threads";
import { bindGhAccount } from "./gh-identity";
import { PAGE_BUDGET_MS, refusalText, type WriteAction } from "./github-writes";
import type { RpcHandlers, ServeDeps } from "./server-modules";

/** The review's threads on GitHub, everyone's, read with `run`: every page, up to 1,000. */
export async function readReviewThreads(repo: string, number: number, run: typeof runGh) {
  const [owner, name] = repo.split("/");
  // Threads come oldest first: page through them all, so the newest aren't the ones dropped.
  const threads: ReturnType<typeof parseReviewThreads>["threads"] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await run(ghReviewThreadsArgs(owner, name, number, after));
    let json: any = null;
    try { json = JSON.parse(r.stdout); } catch { /* reported below */ }
    if (r.code !== 0 || !json?.data) return { threads, error: ghErrorMessage(r) };
    threads.push(...parseReviewThreads(r.stdout).threads);
    const info = json.data.repository?.pullRequest?.reviewThreads?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  return { threads };
}
const THREAD_WRITES = {
  reply: { doing: "replying", kept: " Your reply is still here.", reload: "reply" },
  update: { doing: "updating threads", kept: "", reload: "update its threads" },
};
/** gh bound to the account the page verified, as submitting is; a page that sent none, such as 0.7.0's, is told to reload. */
export async function verifiedGh(account: string | undefined, write: keyof typeof THREAD_WRITES): Promise<{ run: typeof runGh } | { error: string }> {
  const { doing, kept, reload } = THREAD_WRITES[write];
  if (!account) return { error: `Verify your GitHub account before ${doing}. Reload this review to ${reload}.` };
  try { return { run: await bindGhAccount(runGh, account, { doing, kept }) }; }
  catch (error) { return { error: error instanceof Error ? error.message : `Couldn’t use this GitHub account.${kept}` }; }
}
export const NOT_THIS_REVIEW = "That thread isn't part of this review anymore. Refresh and try again.";

export function register(deps: ServeDeps) {
  const { bb, store, receipts, githubWrites } = deps;
  /** Resolve or unresolve one of this PR's threads, as the verified account; any other thread id is refused. */
  async function updateThread(targetKey: string, threadId: string, account: string | undefined, args: string[], action: WriteAction): Promise<{ ok: boolean; error?: string }> {
    const m = await store.getReview(targetKey);
    if (!m || m.kind !== "pr" || !m.number || !m.repo) return { ok: false, error: "Not a PR." };
    const gh = await verifiedGh(account, "update");
    if ("error" in gh) return { ok: false, error: gh.error };
    const ours = (await store.listFeedbackThreads(targetKey)).some((t) => t.id === threadId)
      || (await readReviewThreads(m.repo, m.number, gh.run)).threads.some((t) => t.id === threadId);
    if (!ours) return { ok: false, error: NOT_THIS_REVIEW };
    const r = await githubWrites.post(gh.run, args, { action, budgetMs: PAGE_BUDGET_MS });
    return r.ok ? { ok: true } : { ok: false, error: refusalText(r) };
  }
  const handlers = {
    // GitHub threads, reply/resolve
    async getReviewThreads({ targetKey }) {
      const m = await store.getReview(targetKey);
      if (!m || m.kind !== "pr" || !m.number || !m.repo) return { threads: [] };
      return readReviewThreads(m.repo, m.number, runGh);
    },
    async replyToThread({ targetKey, inReplyTo, body, threadId, account }) {
      const m = await store.getReview(targetKey);
      if (!m || m.kind !== "pr" || !m.number || !m.repo) return { ok: false, error: "Not a PR." };
      const gh = await verifiedGh(account, "reply");
      if ("error" in gh) return { ok: false, error: gh.error };
      const post = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
        const r = await githubWrites.post(gh.run, ghReplyThreadArgs(m.repo!, m.number!, inReplyTo), { stdin: JSON.stringify({ body }), action: "reply", budgetMs: PAGE_BUDGET_MS });
        return r.ok ? { ok: true } : { ok: false, error: refusalText(r) };
      };
      if (!threadId) return post();
      // The thread's drafted reply went out as this one.
      const replied = await postDraftedReply(receipts, store, targetKey, threadId, body, post);
      if (replied.ok) bb.realtime.publish(`feedback:${targetKey}`, { ts: Date.now() });
      return replied;
    },
    async resolveThread({ targetKey, threadId, account }) {
      return updateThread(targetKey, threadId, account, ghResolveThreadArgs(threadId), "resolve");
    },
    async unresolveThread({ targetKey, threadId, account }) {
      return updateThread(targetKey, threadId, account, ghUnresolveThreadArgs(threadId), "unresolve");
    },
  } satisfies Partial<RpcHandlers>;
  return { handlers };
}
