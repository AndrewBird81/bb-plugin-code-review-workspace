import { expect, test, vi } from "vitest";
import { fetchMyThreads, isQuestion, parseAllThreads, parseMyThreads, threadLabel } from "./threads";
import cli9083 from "./fixtures/threads-cli-9083.json";
import { toGithubReviewPayload, type Draft } from "../draft";
import { threadSignals } from "../turn-signals";

const user = (login: string) => ({ __typename: "User", login });
const bot = (login: string) => ({ __typename: "Bot", login });
const at = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, "0")}:00Z`;

/** A review thread node shaped like the query's response; the first comment is "c0". */
function thread(firstAuthor: string, later: Array<[author: unknown, body: string, minute: number]>, overrides: Record<string, unknown> = {}) {
  const first = { id: "c0", databaseId: 100, author: { login: firstAuthor }, body: "Rename this?", createdAt: at(0), pullRequestReview: { id: "PRR_1" } };
  const recent = [{ ...first, author: user(firstAuthor) }, ...later.map(([author, body, minute], i) => ({ id: `c${i + 1}`, author, body, createdAt: at(minute) }))];
  return {
    id: "PRRT_1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 12, originalLine: 10, startLine: null,
    diffSide: "RIGHT", subjectType: "LINE", resolvedBy: null,
    first: { nodes: [first] }, recent: { nodes: recent }, ...overrides,
  };
}
const page = (nodes: unknown[], pageInfo = { hasNextPage: false, endCursor: null as string | null }) =>
  ({ data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes } } } } });
const parseOne = (node: unknown, viewer = "me") => parseMyThreads(page([node]), viewer)[0];

test("parseMyThreads reads a captured cli/cli response", () => {
  const threads = parseMyThreads(cli9083, "andyfeller");
  // Four threads on the PR; three were started by the viewer.
  expect(threads.map((t) => [t.path, t.status])).toEqual([
    ["pkg/cmdutil/errors.go", "resolved"], ["pkg/cmdutil/repo_override.go", "resolved"], ["pkg/cmd/variable/set/set.go", "answered"],
  ]);
  expect(threads[2]).toMatchObject({
    id: "PRRT_kwDODKw3uc5BicAG", commentId: 1720145004, reviewId: "PRR_kwDODKw3uc6FrwJ4", line: null, originalLine: 197, startLine: 178,
    side: "RIGHT", subjectType: "LINE", isOutdated: true, isResolved: false, resolvedBy: null,
    createdAt: Date.parse("2024-08-16T17:55:07Z"), replyAt: Date.parse("2024-08-21T16:20:05Z"),
  });
  expect(threads[2].replies.map((r) => [r.author, r.mine])).toEqual([["andyfeller", true], ["wingleung", false], ["wingleung", false]]);
  expect(threads[0]).toMatchObject({ resolvedBy: "andyfeller", replyAt: null });
});

test("only threads the viewer started are kept, matching the login case-insensitively", () => {
  const threads = parseMyThreads(page([thread("Me", []), thread("bob", [[user("me"), "agreed", 1]])]), "me");
  expect(threads).toHaveLength(1);
  expect(threads[0]).toMatchObject({ body: "Rename this?", commentId: 100, reviewId: "PRR_1", status: "open", replyAt: null, replies: [] });
});

test("replies leave out the first comment, are oldest first, and flag bots and the viewer", () => {
  const t = parseOne(thread("me", [[user("alice"), "b", 3], [bot("github-actions"), "ci", 2], [user("ME"), "a", 1], [user("dependabot[bot]"), "d", 4], [null, "ghost", 5]]));
  expect(t.replies.map((r) => [r.author, r.bot, r.mine])).toEqual([
    ["ME", false, true], ["github-actions", true, false], ["alice", false, false], ["dependabot[bot]", true, false], ["ghost", false, false],
  ]);
});

test("the latest reply from someone else after the viewer's last comment sets the status", () => {
  expect(parseOne(thread("me", [[user("alice"), "Done, renamed.", 1]]))).toMatchObject({ status: "answered", replyAt: Date.parse(at(1)) });
  expect(parseOne(thread("me", [[user("alice"), "Done.", 1], [user("bob"), "Which name do you prefer?", 2]]))).toMatchObject({ status: "question", replyAt: Date.parse(at(2)) });
  expect(parseOne(thread("me", [[user("alice"), "Why?", 1], [user("bob"), "Fixed.", 2]]))).toMatchObject({ status: "answered", replyAt: Date.parse(at(2)) });
});

test("with the PR's author known, only the author answers; someone else counts only when they mention you", () => {
  const one = (later: Array<[unknown, string, number]>) => parseMyThreads(page([thread("me", later)]), "me", "alice")[0];
  expect(one([[user("bob"), "+1, agreed", 1]])).toMatchObject({ status: "open", replyAt: null });
  expect(one([[user("bob"), "Which name?", 1]])).toMatchObject({ status: "open", replyAt: null });
  expect(one([[user("Alice"), "Done.", 1], [user("bob"), "Nice", 2]])).toMatchObject({ status: "answered", replyAt: Date.parse(at(1)) });
  expect(one([[user("alice"), "Done.", 1], [user("bob"), "@me does this cover the retry?", 2]])).toMatchObject({ status: "question", replyAt: Date.parse(at(2)) });
});

test("the viewer replying last leaves the thread open", () => {
  expect(parseOne(thread("me", [[user("alice"), "Why?", 1], [user("me"), "Because of X.", 2]]))).toMatchObject({ status: "open", replyAt: null });
});

test("bot replies don't count as answers", () => {
  expect(parseOne(thread("me", [[bot("coderabbitai"), "Is this right?", 1], [user("renovate[bot]"), "Updated", 2]]))).toMatchObject({ status: "open", replyAt: null });
  expect(parseOne(thread("me", [[user("alice"), "Done", 1], [bot("copilot"), "Summary?", 2]]))).toMatchObject({ status: "answered", replyAt: Date.parse(at(1)) });
});

test("resolved wins over any reply", () => {
  const t = parseOne(thread("me", [[user("alice"), "Can you check again?", 1]], { isResolved: true, resolvedBy: { login: "alice" } }));
  expect(t).toMatchObject({ status: "resolved", replyAt: null, isResolved: true, resolvedBy: "alice" });
});

test("file-level threads have no line", () => {
  const t = parseOne(thread("me", [], { subjectType: "FILE", line: null, originalLine: null, diffSide: null }));
  expect(t).toMatchObject({ subjectType: "FILE", line: null, originalLine: null, side: null });
});

test("isQuestion looks for a question mark in prose, or a mention", () => {
  expect(isQuestion("Should this be async?", "me")).toBe(true);
  expect(isQuestion("Done. @Me take another look", "me")).toBe(true);
  expect(isQuestion("Done, thanks!", "me")).toBe(false);
  expect(isQuestion("Changed to `a?.b`", "me")).toBe(false);
  expect(isQuestion("Changed:\n```ts\nconst x = a ?? b;\nif (x?.y) {}\n```\nDone.", "me")).toBe(false);
  expect(isQuestion("~~~\nwhat?\n~~~", "me")).toBe(false);
  expect(isQuestion("```\nunclosed?", "me")).toBe(false);
  expect(isQuestion("> Should this be async?\n\nYes, done.", "me")).toBe(false);
  expect(isQuestion("See https://example.com/a?b=1", "me")).toBe(false);
  expect(isQuestion("Mail me@me.dev", "me")).toBe(false);
  expect(isQuestion("`@me` is the handle", "me")).toBe(false);
  expect(isQuestion("```\ncode\n```\nWhat about the other call?", "me")).toBe(true);
});

test("fetchMyThreads pages with the end cursor, up to 1,000 threads", async () => {
  const run = vi.fn(async (args: string[]) => {
    const n = run.mock.calls.length;
    return { code: 0, stderr: "", stdout: JSON.stringify(page([thread("me", [])], { hasNextPage: true, endCursor: `cursor${n}` })) };
  });
  const threads = await fetchMyThreads(run, "cli/cli", 9083, "me");
  expect(run).toHaveBeenCalledTimes(10);
  expect(threads).toHaveLength(10);
  const [first] = run.mock.calls[0];
  expect(first).toEqual(expect.arrayContaining(["api", "graphql", "owner=cli", "repo=cli", "number=9083"]));
  expect(first.some((a) => a.startsWith("after="))).toBe(false);
  expect(run.mock.calls[2][0].slice(-2)).toEqual(["-f", "after=cursor2"]);
  expect(run.mock.calls[0][0].join(" ")).not.toMatch(/mutation/i);
});

test("fetchMyThreads stops at the last page", async () => {
  const run = vi.fn(async () => ({ code: 0, stderr: "", stdout: JSON.stringify(page([thread("me", [])])) }));
  await fetchMyThreads(run, "cli/cli", 1, "me");
  expect(run).toHaveBeenCalledTimes(1);
  // Every comment's author says whether it's a bot, the thread's first too: GitHub names bots without "[bot]".
  const query = (run.mock.calls[0] as unknown as [string[]])[0].find((arg) => arg.startsWith("query="))!;
  expect(query).toContain("first:comments(first:1){nodes{id databaseId author{__typename login}");
  expect(query).toContain("recent:comments(last:10){nodes{id author{__typename login}");
});

test("fetchMyThreads rejects on a failed or unreadable response", async () => {
  await expect(fetchMyThreads(vi.fn(async () => ({ code: 1, stderr: "HTTP 502", stdout: "" })), "cli/cli", 1, "me")).rejects.toThrow(/502/);
  await expect(fetchMyThreads(vi.fn(async () => ({ code: 0, stderr: "", stdout: "<html>" })), "cli/cli", 1, "me")).rejects.toThrow();
});

test("parseAllThreads keeps everyone's threads, bots included, with the first comment and the latest reply", () => {
  const botFirst = { ...thread("x", []), id: "PRRT_2", first: { nodes: [{ id: "b0", author: bot("coderabbitai"), body: "Possible null deref." }] }, recent: { nodes: [{ id: "b0", author: bot("coderabbitai"), body: "Possible null deref." }] } };
  const threads = parseAllThreads(page([thread("bob", [[user("alice"), "Fixed.", 1], [user("bob"), "Thanks!", 2]]), botFirst, thread("me", [], { isResolved: true })]));
  expect(threads).toEqual([
    { id: "PRRT_1", path: "src/a.ts", line: 12, isResolved: false, isOutdated: false, author: "bob", bot: false, body: "Rename this?", latestReply: { author: "bob", bot: false, body: "Thanks!" } },
    { id: "PRRT_2", path: "src/a.ts", line: 12, isResolved: false, isOutdated: false, author: "coderabbitai", bot: true, body: "Possible null deref.", latestReply: null },
    { id: "PRRT_1", path: "src/a.ts", line: 12, isResolved: true, isOutdated: false, author: "me", bot: false, body: "Rename this?", latestReply: null },
  ]);
  expect(parseAllThreads(cli9083)).toHaveLength(4);
});

test("a thread's label is its first comment's: a severity's, or a non-blocking one", () => {
  expect(threadLabel("**Nit:** spacing")).toEqual({ label: "Nit", nonBlocking: true });
  expect(threadLabel("nit: spacing")).toEqual({ label: "Nit", nonBlocking: true });
  expect(threadLabel("FYI: there's a helper for this")).toEqual({ label: "FYI", nonBlocking: true });
  expect(threadLabel("**Optional**: inline it")).toEqual({ label: "Optional", nonBlocking: true });
  expect(threadLabel("Non-blocking: rename")).toEqual({ label: "Non-blocking", nonBlocking: true });
  expect(threadLabel("nonblocking: rename")).toEqual({ label: "Non-blocking", nonBlocking: true });
  expect(threadLabel("non blocking: rename")).toEqual({ label: "Non-blocking", nonBlocking: true });
  expect(threadLabel("**Blocking:** drops writes")).toEqual({ label: "Blocking", nonBlocking: false });
  expect(threadLabel("**Should fix:** rename")).toEqual({ label: "Should fix", nonBlocking: false });
  expect(threadLabel("Question: why?")).toEqual({ label: "Question", nonBlocking: false });
  expect(threadLabel("Rename this?")).toBeNull();
  expect(threadLabel("A nit: spacing")).toBeNull();
  expect(threadLabel("**FYI: unclosed")).toBeNull();
});

test("fetchMyThreads reads a thread you started after the first 300, and stops at the thread list's 1,000", async () => {
  const node = (id: string, login: string) => ({
    id, isResolved: false, isOutdated: false, path: "a.ts", line: 1, originalLine: 1, startLine: null, diffSide: "RIGHT", subjectType: "LINE", resolvedBy: null,
    first: { nodes: [{ id: `${id}-c`, databaseId: 1, author: { login }, body: "Please fix", createdAt: "2026-10-01T00:00:00Z", pullRequestReview: null }] },
    recent: { nodes: [] },
  });
  // Threads oldest first; yours is the newest.
  const pr = (total: number) => vi.fn(async (args: string[]) => {
    const start = Number(args.find((a) => a.startsWith("after="))?.slice(6) ?? 0);
    const nodes = Array.from({ length: 100 }, (_, i) => node(`t${start + i}`, start + i === total - 1 ? "me" : "alice"));
    return { code: 0, stderr: "", stdout: JSON.stringify(page(nodes, { hasNextPage: start + 100 < total, endCursor: String(start + 100) })) };
  });
  const four = pr(400);
  expect((await fetchMyThreads(four, "acme/web", 1, "me", "alice")).map((t) => t.id)).toEqual(["t399"]);
  expect(four).toHaveBeenCalledTimes(4);
  const huge = pr(1200);
  await fetchMyThreads(huge, "acme/web", 1, "me", "alice");
  expect(huge).toHaveBeenCalledTimes(10);
});

// With Keep pre-existing problems apart on, a pre-existing comment posts "**Pre-existing:**" before its severity (bug bash DOC-1).
test("a pre-existing comment's label is the severity after its Pre-existing mark", () => {
  const posted = toGithubReviewPayload({
    verdict: "COMMENT", body: "", comments: [{ file: "src/a.ts", line: 3, side: "RIGHT", severity: "nit", introduced: false, body: "Rename this to `count`." }],
  } as unknown as Draft, true).comments[0].body;
  expect(posted).toBe("**Pre-existing:** **Nit:** Rename this to `count`.");
  expect(threadLabel(posted)).toEqual({ label: "Nit", nonBlocking: true });
  expect(threadLabel("**Pre-existing:** **Blocking:** drops writes")).toEqual({ label: "Blocking", nonBlocking: false });
  expect(threadLabel("Pre-existing: nit: spacing")).toEqual({ label: "Nit", nonBlocking: true });
  expect(threadLabel("**Pre-existing:** this was already broken")).toBeNull();
  expect(threadLabel("**Pre-existing:** **Pre-existing:** **Nit:** twice")).toBeNull();
  // An open pre-existing nit counts apart, so it doesn't keep the review on the author.
  const signals = threadSignals([{
    id: "PRRT_1", commentId: 1, reviewId: null, path: "src/a.ts", line: 3, originalLine: 3, startLine: null, side: "RIGHT", subjectType: "LINE",
    body: posted, createdAt: 0, isResolved: false, resolvedBy: null, isOutdated: false, replies: [], status: "open", replyAt: null,
  }]);
  expect(signals.threads).toMatchObject({ total: 0, open: 0, nonBlocking: 1 });
});

// Your own PR (S6): everyone's threads, and a thread needs your reply when its latest comment that isn't a bot's isn't yours.

test("on your own PR, everyone's threads are kept, and one someone else started needs your reply", () => {
  const threads = parseMyThreads(page([thread("bob", []), { ...thread("me", []), id: "PRRT_2" }]), "me", "me");
  expect(threads.map((t) => [t.id, t.author, t.status, t.needsReply])).toEqual([
    ["PRRT_1", "bob", "question", { comments: 1, at: Date.parse(at(0)), by: "bob" }],
    ["PRRT_2", undefined, "open", undefined],
  ]);
});

test("on your own PR, your reply answers a thread, and a teammate's comment after it asks again, counting every comment since yours", () => {
  const own = (later: Array<[unknown, string, number]>, first = "bob") => parseMyThreads(page([thread(first, later)]), "me", "Me")[0];
  expect(own([[user("me"), "Done.", 1]])).toMatchObject({ author: "bob", status: "open" });
  expect(own([[user("me"), "Done.", 1]]).needsReply).toBeUndefined();
  expect(own([[user("me"), "Done.", 1], [user("bob"), "Thanks", 2], [user("carol"), "Why not a map?", 3]])).toMatchObject({
    status: "question", replyAt: Date.parse(at(3)), needsReply: { comments: 2, at: Date.parse(at(3)), by: "carol" },
  });
  // Your own thread, which a teammate answered.
  expect(own([[user("bob"), "Agreed", 1]], "me")).toMatchObject({ status: "answered", needsReply: { comments: 1, by: "bob" } });
  expect(own([[user("bob"), "Agreed", 1]], "me").author).toBeUndefined();
});

test("on your own PR, a bot's comments never ask for your reply, whether it started the thread or came last", () => {
  const own = (node: unknown) => parseMyThreads(page([node]), "me", "me")[0];
  // GitHub's GraphQL names bots without "[bot]": only __typename tells them.
  const copilot = bot("copilot-pull-request-reviewer");
  const started = thread("x", [[bot("coderabbitai"), "Also here", 1]]);
  const botThread = { ...started, first: { nodes: [{ ...started.first.nodes[0], author: copilot }] }, recent: { nodes: [{ ...started.recent.nodes[0], author: copilot }, ...started.recent.nodes.slice(1)] } };
  expect(own(botThread)).toMatchObject({ author: "copilot-pull-request-reviewer", authorBot: true, status: "open" });
  expect(own(botThread).needsReply).toBeUndefined();
  expect(own(thread("me", [[bot("github-actions"), "Lint failed", 1]])).needsReply).toBeUndefined();
  // A person's comment after a bot's still does; the bot's isn't counted.
  expect(own(thread("me", [[user("bob"), "Can you look?", 1], [bot("github-actions"), "ci", 2]]))).toMatchObject({ needsReply: { comments: 1, at: Date.parse(at(1)), by: "bob" } });
});

test("on your own PR, a resolved thread needs nothing", () => {
  const t = parseMyThreads(page([thread("bob", [], { isResolved: true })]), "me", "me")[0];
  expect(t).toMatchObject({ author: "bob", status: "resolved" });
  expect(t.needsReply).toBeUndefined();
});

test("on a teammate's PR, only your threads are kept, read as before", () => {
  const nodes = [thread("bob", [[user("alice"), "Fixed", 1]]), { ...thread("me", [[user("alice"), "Fixed", 1]]), id: "PRRT_2" }];
  const threads = parseMyThreads(page(nodes), "me", "alice");
  expect(threads.map((t) => [t.id, t.status])).toEqual([["PRRT_2", "answered"]]);
  expect(threads[0]).not.toHaveProperty("author");
  expect(threads[0]).not.toHaveProperty("needsReply");
});

test("threadSignals counts what waits for your reply on your own PR, and adds nothing on a teammate's", () => {
  const nodes = [thread("bob", [[user("carol"), "+1", 2]]), { ...thread("me", [[user("dan"), "Hm?", 5]]), id: "PRRT_2" }, { ...thread("x", []), id: "PRRT_3", first: { nodes: [{ id: "c0", databaseId: 1, author: bot("github-actions"), body: "Lint", createdAt: at(6) }] } }];
  const own = threadSignals(parseMyThreads(page(nodes), "me", "me"), true);
  expect(own.newComments).toEqual({ count: 3, threads: 2, at: Date.parse(at(5)), by: "dan" });
  expect(threadSignals(parseMyThreads(page([thread("me", [])]), "me", "me"), true).newComments).toBeNull();
  expect(threadSignals(parseMyThreads(page(nodes), "me", "alice"))).not.toHaveProperty("newComments");
});
