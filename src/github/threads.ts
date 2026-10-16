// The review threads the viewer started on a PR, and whether each awaits the viewer.
import { mentions } from "./pr-facts";
import type { FeedbackThread, RunGh } from "./types";

const PAGE_SIZE = 100;
const MAX_THREADS = 1000;

const QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    reviewThreads(first:${PAGE_SIZE},after:$after){pageInfo{hasNextPage endCursor} nodes{
      id isResolved isOutdated path line originalLine startLine diffSide subjectType resolvedBy{login}
      first:comments(first:1){nodes{id databaseId author{login} body createdAt pullRequestReview{id}}}
      recent:comments(last:10){nodes{id author{__typename login} body createdAt}}
    }}
  }}
}`;

/** Pages through the PR's review threads (up to 1,000, as the thread list does); a transport failure or unparseable output rejects. */
export async function fetchMyThreads(run: RunGh, repo: string, number: number, viewer: string, author: string | null = null): Promise<FeedbackThread[]> {
  const [owner, name] = repo.split("/");
  const threads: FeedbackThread[] = [];
  let after: string | null = null;
  for (let read = 0; read < MAX_THREADS; read += PAGE_SIZE) {
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, "-F", `number=${number}`];
    if (after) args.push("-f", `after=${after}`);
    const out = await run(args);
    let json: any;
    try { json = JSON.parse(out.stdout); } catch { json = null; }
    if (out.code !== 0 || !json?.data) throw new Error(`Could not read review threads: ${out.stderr.trim() || `gh exited ${out.code}`}`);
    threads.push(...parseMyThreads(json, viewer, author));
    const page = json.data.repository?.pullRequest?.reviewThreads?.pageInfo;
    if (!page?.hasNextPage || !page.endCursor) break;
    after = page.endCursor;
  }
  return threads;
}

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const isBot = (author: { __typename?: string; login?: string } | null | undefined) =>
  author?.__typename === "Bot" || !!author?.login?.toLowerCase().endsWith("[bot]");

/**
 * With the PR's `author` known, only the author's reply answers or asks; anyone else's counts only
 * when it mentions the viewer, as a question. Without it, anyone's does.
 */
export function parseMyThreads(json: unknown, viewer: string, author: string | null = null): FeedbackThread[] {
  const nodes: any[] = (json as any)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return nodes.flatMap((t) => {
    const first = t?.first?.nodes?.[0];
    if (!first || !same(first.author?.login, viewer)) return [];
    const createdAt = Date.parse(first.createdAt);
    const replies: FeedbackThread["replies"] = (t.recent?.nodes ?? [])
      .filter((c: any) => c && c.id !== first.id)
      .map((c: any) => ({
        author: c.author?.login ?? "ghost", bot: isBot(c.author), mine: same(c.author?.login, viewer),
        body: c.body ?? "", createdAt: Date.parse(c.createdAt),
      }))
      .sort((a: { createdAt: number }, b: { createdAt: number }) => a.createdAt - b.createdAt);
    const thread: FeedbackThread = {
      id: t.id, commentId: first.databaseId, reviewId: first.pullRequestReview?.id ?? null,
      path: t.path ?? null, line: t.line ?? null, originalLine: t.originalLine ?? null, startLine: t.startLine ?? null,
      side: t.diffSide ?? null, subjectType: t.subjectType === "FILE" ? "FILE" : "LINE",
      body: first.body ?? "", createdAt, isResolved: !!t.isResolved, resolvedBy: t.resolvedBy?.login ?? null,
      isOutdated: !!t.isOutdated, replies, status: "resolved", replyAt: null,
    };
    if (thread.isResolved) return [thread];
    const myLast = Math.max(createdAt, ...replies.filter((r) => r.mine).map((r) => r.createdAt));
    const fromAuthor = (r: { author: string }) => !author || same(r.author, author);
    const reply = replies.filter((r) => !r.mine && !r.bot && r.createdAt > myLast && (fromAuthor(r) || mentions(proseOf(r.body), viewer))).at(-1);
    if (!reply) return [{ ...thread, status: "open" }];
    return [{ ...thread, status: isQuestion(reply.body, viewer) ? "question" : "answered", replyAt: reply.createdAt }];
  });
}

/** Whether a reply asks the viewer something: a "?" outside code spans/blocks and quoted lines, or an @viewer mention. */
export function isQuestion(body: string, viewer: string): boolean {
  const prose = proseOf(body);
  if (mentions(prose, viewer)) return true;
  // A "?" in a link's query string isn't a question.
  return prose.split("\n").filter((line) => !/^\s*>/.test(line)).join("\n").replace(/https?:\/\/\S+/g, "").includes("?");
}

const THREAD_LABELS: Record<string, { label: string; nonBlocking: boolean }> = {
  blocking: { label: "Blocking", nonBlocking: false }, shouldfix: { label: "Should fix", nonBlocking: false }, question: { label: "Question", nonBlocking: false },
  nit: { label: "Nit", nonBlocking: true }, fyi: { label: "FYI", nonBlocking: true }, optional: { label: "Optional", nonBlocking: true }, nonblocking: { label: "Non-blocking", nonBlocking: true },
};
// "**Nit:**", "**Nit**:", or "Nit:", in any case, at the start of the first comment.
const THREAD_LABEL = /^\s*(\*\*|__)?(blocking|should[ -]fix|question|nit|fyi|optional|non[ -]?blocking)(?:\1:|:\1)/i;

/**
 * The label a thread's first comment starts with: a severity's (src/draft.ts), or nit, FYI, optional, or
 * non-blocking, which make it non-blocking: it doesn't hold the author's turn. Null without one.
 */
export function threadLabel(body: string): { label: string; nonBlocking: boolean } | null {
  const match = body.match(THREAD_LABEL);
  return match ? THREAD_LABELS[match[2].toLowerCase().replace(/[ -]/g, "")] : null;
}

/** A review thread anyone started on the PR, briefly. */
export interface PrThread {
  id: string;
  path: string | null;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  author: string;
  bot: boolean;
  /** The first comment. */
  body: string;
  latestReply: { author: string; bot: boolean; body: string } | null;
}

/** Every review thread in a response shaped like QUERY's, whoever started it. */
export function parseAllThreads(json: unknown): PrThread[] {
  const nodes: any[] = (json as any)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return nodes.flatMap((t) => {
    const first = t?.first?.nodes?.[0];
    if (!first) return [];
    const last = (t.recent?.nodes ?? []).filter((c: any) => c && c.id !== first.id).at(-1);
    return [{
      id: t.id, path: t.path ?? null, line: t.line ?? null, isResolved: !!t.isResolved, isOutdated: !!t.isOutdated,
      author: first.author?.login ?? "ghost", bot: isBot(first.author), body: first.body ?? "",
      latestReply: last ? { author: last.author?.login ?? "ghost", bot: isBot(last.author), body: last.body ?? "" } : null,
    }];
  });
}

/** The text outside code spans and blocks. */
function proseOf(body: string): string {
  return body
    .replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?(^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, "")
    .replace(/(`+)[\s\S]*?\1/g, "");
}
