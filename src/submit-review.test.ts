import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { reanchorDraft } from "./store";
import { toGithubReviewPayload } from "./draft";
import { createReviewSubmitter } from "./submit-review";
import { createGithubWrites } from "./github-writes";
import type { runGh } from "./gh";
import { reviewRevision } from "./review-revision";
import plugin from "../server";
import type { AsyncStore } from "./store-queue";
import { testStore } from "./test-store.test-support";
import { postReceipts, reviewReceiptKey } from "./post-receipts";

// The server's gh, for submitting through the RPC; the submitter's own tests pass theirs.
const serverGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<typeof import("./gh")>()), runGh: serverGh }));

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
async function setup() {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-test", kind: "pr", repo: "acme/web", number: 7, status: "ready", createdAt: 1, headSha: "sha1" });
  await store.savePatch("pr-test", patch);
  await store.upsertDraftComment("pr-test", { file: "a.ts", line: 1, side: "RIGHT", body: "Please explain this" });
  await store.setVerdict("pr-test", "COMMENT", "My summary");
  const run = vi.fn<typeof runGh>(async (args) => ({ code: 0, stderr: "", stdout: args[0] === "pr" ? '{"headRefOid":"sha1"}' : '{"id":12}' }));
  /** What the reviewer's page shows of a draft now: its comments, then its summary and verdict. */
  const page = async (key = "pr-test") => {
    const { comments, body, verdict } = await store.getDraft(key);
    return [comments, { body, verdict }] as const;
  };
  return { store, run, page, submit: createReviewSubmitter(store, run) };
}

test("submission pins the reviewed commit and clears only the submitted draft", async () => {
  const { store, run, submit, page } = await setup();
  await store.saveReviewerNotes("pr-test", "Private: ask about rollout", 0);
  expect(await submit("pr-test", undefined, undefined, ...await page("pr-test"))).toEqual({ ok: true });
  expect(run).toHaveBeenLastCalledWith(expect.arrayContaining(["repos/acme/web/pulls/7/reviews"]), {
    // Five minutes: a submission that hangs past it is looked for on GitHub, never posted again blind.
    timeoutMs: 300_000,
    stdin: JSON.stringify({ event: "COMMENT", body: "My summary", comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "Please explain this" }], commit_id: "sha1" }),
  });
  expect(await store.getDraft("pr-test")).toMatchObject({ verdict: "COMMENT", body: "", comments: [] });
  expect((await store.getReviewerNotes("pr-test")).body).toBe("Private: ask about rollout");
  expect(await submit("pr-test", undefined, undefined, ...await page("pr-test"))).toMatchObject({ ok: false });
  expect(run).toHaveBeenCalledTimes(2);
});

test("a comment on a line only in the folder never goes to GitHub: not in the payload, not warned about, and kept in the draft", async () => {
  const { store, run, submit, page } = await setup();
  await store.saveSnapshot("pr-test", "not-pushed", "diff --git a/b.ts b/b.ts\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+fresh\n");
  await store.upsertDraftComment("pr-test", { file: "b.ts", line: 1, side: "LOCAL", body: "Not pushed yet" });
  const draft = await store.getDraft("pr-test");
  for (const own of [true, false]) expect(toGithubReviewPayload(draft, false, own).comments.map((c) => c.path)).toEqual(["a.ts"]);
  expect(await submit("pr-test", undefined, undefined, ...await page())).toEqual({ ok: true });
  expect(JSON.parse(run.mock.calls.at(-1)![1]!.stdin!).comments).toEqual([{ path: "a.ts", line: 1, side: "RIGHT", body: "Please explain this" }]);
  expect((await store.getDraft("pr-test")).comments.map((c) => c.body)).toEqual(["Not pushed yet"]);
});

test("how the agent checked a comment stays in BB: GitHub gets the comment without it", async () => {
  const { store, run, submit, page } = await setup();
  await store.upsertDraftComment("pr-test", { file: "a.ts", line: 1, side: "RIGHT", author: "agent", severity: "should-fix", body: "Please explain this", evidence: "Read a.ts:1 and its callers." });
  expect(await submit("pr-test", undefined, undefined, ...await page())).toEqual({ ok: true });
  const sent = run.mock.calls.at(-1)![1]!.stdin!;
  expect(JSON.parse(sent).comments).toEqual([{ path: "a.ts", line: 1, side: "RIGHT", body: "**Should fix:** Please explain this" }]);
  expect(sent).not.toContain("evidence");
  expect(sent).not.toContain("Read a.ts:1");
});

test("a pre-existing problem posts with “Pre-existing:” in front while Settings keeps them apart, and as any comment with it off", async () => {
  const { store, run, submit, page } = await setup();
  await store.upsertDraftComment("pr-test", { file: "a.ts", line: 1, side: "RIGHT", author: "agent", severity: "blocking", body: "This was already unchecked.", introduced: false });
  expect(await submit("pr-test", undefined, undefined, ...await page())).toEqual({ ok: true });
  expect(JSON.parse(run.mock.calls.at(-1)![1]!.stdin!).comments).toEqual([{ path: "a.ts", line: 1, side: "RIGHT", body: "**Pre-existing:** **Blocking:** This was already unchecked." }]);

  const { store: off, run: offRun, submit: offSubmit, page: offPage } = await setup();
  await off.savePreferences({ ...(await off.getPreferences()).preferences, knobs: { ...(await off.getPreferences()).preferences.knobs, preExistingFindings: false } }, (await off.getPreferences()).revision);
  await off.upsertDraftComment("pr-test", { file: "a.ts", line: 1, side: "RIGHT", body: "This was already unchecked.", introduced: false });
  expect(await offSubmit("pr-test", undefined, undefined, ...await offPage())).toEqual({ ok: true });
  expect(JSON.parse(offRun.mock.calls.at(-1)![1]!.stdin!).comments).toEqual([{ path: "a.ts", line: 1, side: "RIGHT", body: "This was already unchecked." }]);
});

test("a comment marked pre-existing, or no longer, since the page showed it holds the submission", async () => {
  const { store, run, submit, page } = await setup();
  const [shown, summary] = await page();
  await store.upsertDraftComment("pr-test", { ...shown[0], introduced: false });
  expect(await submit("pr-test", undefined, undefined, shown, summary)).toMatchObject({ ok: false, error: expect.stringContaining("Draft changed · review it") });
  expect(run).not.toHaveBeenCalled();
});

test("new PR commits warn, posting nothing and keeping the draft; Submit anyway posts on the version you reviewed", async () => {
  const { store, run, submit, page } = await setup();
  const draft = await store.getDraft("pr-test");
  run.mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"headRefOid":"sha2"}' });
  expect(await submit("pr-test", undefined, undefined, ...await page("pr-test"))).toMatchObject({
    ok: false, warning: "New commits since you reviewed. Submitting now posts on the version you reviewed.", warnings: ["new-commits"], offers: ["anyway"],
    newCommits: { count: null, url: "https://github.com/acme/web/compare/sha1...sha2" },
  });
  expect(run.mock.calls.some(([args]) => args.includes("POST"))).toBe(false);
  expect(await store.getDraft("pr-test")).toEqual(draft);
  run.mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"headRefOid":"sha2"}' });
  expect(await submit("pr-test", undefined, undefined, ...await page("pr-test"), { force: true })).toEqual({ ok: true });
  const [, options] = run.mock.calls.find(([args]) => args.includes("POST"))!;
  expect(JSON.parse(options!.stdin!).commit_id).toBe("sha1");
  expect(await store.getReview("pr-test")).toMatchObject({ submittedHeadSha: "sha1" });
});

test("an approval past new commits says how many you haven't seen", async () => {
  const { store, run, submit, page } = await setup();
  await store.setVerdict("pr-test", "APPROVE", "Ship it");
  run.mockImplementation(async (args) => ({ code: 0, stderr: "", stdout: args[0] === "pr" ? '{"headRefOid":"sha3"}' : args[1] === "repos/acme/web/compare/sha1...sha3" ? "2\n" : "{}" }));
  expect(await submit("pr-test", undefined, undefined, ...await page())).toMatchObject({
    ok: false, warning: "2 new commits since you reviewed. Approving now covers them unseen.",
  });
  expect(run.mock.calls.some(([args]) => args.includes("POST"))).toBe(false);
});

test("a PR retargeted to a new base warns, posting nothing and keeping the draft", async () => {
  const { store, run, submit, page } = await setup();
  await store.saveReview({ ...(await store.getReview("pr-test"))!, base: "parent" });
  const draft = await store.getDraft("pr-test");
  run.mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"headRefOid":"sha1","baseRefName":"main"}' });
  expect(await submit("pr-test", undefined, undefined, ...await page("pr-test"))).toMatchObject({ ok: false, warning: "The PR's base changed to main since you reviewed it.", warnings: ["base-changed"], offers: ["anyway"] });
  expect(run).toHaveBeenCalledTimes(1);
  expect(await store.getDraft("pr-test")).toEqual(draft);
});

test("a failed GitHub write keeps the draft and surfaces field errors", async () => {
  const { store, run, submit, page } = await setup();
  const draft = await store.getDraft("pr-test");
  run.mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"headRefOid":"sha1"}' })
    .mockResolvedValueOnce({ code: 1, stderr: "HTTP 422", stdout: '{"message":"Validation Failed","errors":[{"message":"line must be part of the diff"}]}' });
  expect(await submit("pr-test", undefined, undefined, ...await page("pr-test"))).toMatchObject({ ok: false, error: expect.stringContaining("line must be part of the diff") });
  expect(await store.getDraft("pr-test")).toEqual(draft);
});

test("concurrent submit clicks send one write and retain edits made during the request", async () => {
  const { store, run, submit, page } = await setup();
  let finish!: (value: Awaited<ReturnType<typeof runGh>>) => void;
  run.mockImplementation(async (args) => args[0] === "pr"
    ? { code: 0, stderr: "", stdout: '{"headRefOid":"sha1"}' }
    : new Promise((resolve) => { finish = resolve; }));
  const first = submit("pr-test", undefined, undefined, ...await page("pr-test"));
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(await submit("pr-test", undefined, undefined, ...await page("pr-test"))).toMatchObject({ ok: false, error: expect.stringContaining("already") });
  await store.setVerdict("pr-test", "COMMENT", "A new summary");
  await store.upsertDraftComment("pr-test", { file: "a.ts", line: 1, side: "RIGHT", body: "Edited while sending" });
  finish({ code: 0, stdout: '{"id":12}', stderr: "" });
  expect(await first).toEqual({ ok: true });
  expect(run).toHaveBeenCalledTimes(2);
  expect(await store.getDraft("pr-test")).toMatchObject({ body: "A new summary", comments: [{ body: "Edited while sending" }] });
});

// bug bash DFT-1: a rebuild during the POST moves the draft's comments; the ones sent mustn't stay to be posted again.
const twoLines = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n";
/** A submit of the draft's comment on line 2 whose POST waits for `finish`. */
async function postingOnLine2(store: AsyncStore) {
  await store.savePatch("pr-test", twoLines);
  await store.deleteDraftComment("pr-test", { file: "a.ts", line: 1, side: "RIGHT" });
  await store.upsertDraftComment("pr-test", { file: "a.ts", line: 2, side: "RIGHT", body: "Please explain this" });
  let finish!: (value: Awaited<ReturnType<typeof runGh>>) => void;
  const run = vi.fn<typeof runGh>(async (args) => args[0] === "pr"
    ? { code: 0, stderr: "", stdout: '{"headRefOid":"sha1"}' }
    : new Promise((resolve) => { finish = resolve; }));
  const { comments, body, verdict } = await store.getDraft("pr-test");
  const sending = createReviewSubmitter(store, run)("pr-test", undefined, undefined, comments, { body, verdict });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  return { sending, finish: () => finish({ code: 0, stderr: "", stdout: '{"id":12,"node_id":"R_1"}' }) };
}

test("comments a rebuild moved while Submit posted them don't stay in the draft to be posted again", async () => {
  const { store } = await setup();
  const post = await postingOnLine2(store);
  // The sync's rebuild for a new commit that adds a line above, as rebuildReview does it, lands while GitHub answers.
  const next = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n+top\n ctx\n-old\n+new\n";
  const previous = await store.patch("pr-test");
  await store.savePatch("pr-test", next);
  await store.saveReview({ ...(await store.getReview("pr-test"))!, status: "generating", headSha: "sha2" });
  await store.rebaseDraftComments("pr-test", await reanchorDraft(store, "pr-test", previous, next));
  expect((await store.getDraft("pr-test")).comments[0].line).toBe(3);
  post.finish();
  expect(await post.sending).toEqual({ ok: true });
  expect((await store.getDraft("pr-test")).comments).toEqual([]);
});

test("a comment like a submitted one, added on another line while Submit posted, stays in the draft", async () => {
  const { store } = await setup();
  const post = await postingOnLine2(store);
  await store.upsertDraftComment("pr-test", { file: "a.ts", line: 1, side: "RIGHT", body: "Please explain this" });
  post.finish();
  expect(await post.sending).toEqual({ ok: true });
  expect((await store.getDraft("pr-test")).comments).toEqual([{ file: "a.ts", line: 1, side: "RIGHT", body: "Please explain this" }]);
});

test("re-review cannot silently reuse comments whose line still exists in a changed diff: it warns, and Submit anyway moves them into the summary", async () => {
  const { store, run, submit, page } = await setup();
  await store.savePatch("pr-test", patch.replace("+new", "+different"));
  expect(await submit("pr-test", undefined, undefined, ...await page("pr-test"))).toMatchObject({
    ok: false, warning: "1 comment was drafted on an older diff (a.ts:1). Submitting anyway moves it into the summary.", warnings: ["older-diff"], offers: ["anyway"],
  });
  expect(run.mock.calls.some(([args]) => args.includes("POST"))).toBe(false);
  expect(await submit("pr-test", undefined, undefined, ...await page("pr-test"), { force: ["older-diff"] })).toEqual({ ok: true });
  const [, options] = run.mock.calls.find(([args]) => args.includes("POST"))!;
  const payload = JSON.parse(options!.stdin!);
  expect(payload.comments).toEqual([]);
  expect(payload.body).toBe("My summary\n\n- On `a.ts:1` (an earlier diff): Please explain this");
  // It left the draft with the rest of what posted.
  expect(await store.getDraft("pr-test")).toMatchObject({ comments: [], body: "" });
});

test("submission refuses draft comments the reviewer's page hasn't shown", async () => {
  const { store, run, submit, page } = await setup();
  const shown = (await store.getDraft("pr-test")).comments;
  await store.upsertDraftComment("pr-test", { file: "a.ts", line: 1, side: "LEFT", body: "Added by the assistant" });
  expect(await submit("pr-test", undefined, undefined, shown, (await page())[1])).toMatchObject({ ok: false, error: expect.stringContaining("Draft changed · review it") });
  expect(run).not.toHaveBeenCalled();
  expect((await store.getDraft("pr-test")).comments).toHaveLength(2);
  expect(await submit("pr-test", undefined, undefined, ...await page())).toEqual({ ok: true });
});

test("a blank draft comment holds the submission, and says it can't be blank (bug bash DOC-8)", async () => {
  const { store, run, submit, page } = await setup();
  await store.upsertDraftComment("pr-test", { file: "a.ts", line: 1, side: "RIGHT", body: " " });
  expect(await submit("pr-test", undefined, undefined, ...await page())).toEqual({ ok: false, error: "Draft comments can't be blank." });
  expect(run).not.toHaveBeenCalled();
});

test("local refs never submit to GitHub", async () => {
  const { store, run, submit, page } = await setup();
  await store.saveReview({ targetKey: "local", kind: "ref", gitRef: "HEAD", status: "ready", createdAt: 1 });
  await store.setVerdict("local", "APPROVE", "");
  expect(await submit("local", undefined, undefined, ...await page("local"))).toMatchObject({ ok: false });
  expect(run).not.toHaveBeenCalled();
});

test("approval persists separately from the cleared draft and survives metadata refresh", async () => {
  const { store, submit, page } = await setup();
  await store.setVerdict("pr-test", "APPROVE", "Looks good");
  expect(await submit("pr-test", undefined, undefined, ...await page("pr-test"))).toEqual({ ok: true });
  expect(await store.getReview("pr-test")).toMatchObject({ submittedVerdict: "APPROVE", submittedHeadSha: "sha1", submittedAt: expect.any(Number) });
  const { submittedVerdict, submittedHeadSha, submittedAt, ...meta } = (await store.getReview("pr-test"))! as any;
  await store.saveReview(meta);
  expect(await store.getReview("pr-test")).toMatchObject({ submittedVerdict: "APPROVE" });
});

test("a PR merged since opening the workspace warns before submitting, and archives the review", async () => {
  const { store, run, submit, page } = await setup();
  run.mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"headRefOid":"sha1","state":"MERGED"}' });
  expect(await submit("pr-test", undefined, undefined, ...await page("pr-test"))).toMatchObject({ ok: false, warning: "This PR is merged.", offers: ["anyway"] });
  expect(run).toHaveBeenCalledTimes(1);
  expect(await store.getReview("pr-test")).toMatchObject({ prState: "MERGED", archivedAt: expect.any(Number) });
  expect((await store.getDraft("pr-test")).comments).toHaveLength(1);
});

test("submission records the reviewer from GitHub so account switches cannot misattribute it", async () => {
  const { store, run, submit, page } = await setup();
  run.mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"headRefOid":"sha1","state":"OPEN"}' })
    .mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"id":12,"user":{"login":"reviewer"}}' });
  expect(await submit("pr-test", undefined, undefined, ...await page("pr-test"))).toEqual({ ok: true });
  expect((await store.getReview("pr-test"))?.reviewer).toBe("reviewer");
});

test("submission refuses a summary or verdict the page didn't show", async () => {
  const { store, run, submit, page } = await setup();
  const comments = (await store.getDraft("pr-test")).comments;
  // The assistant rewrote the summary after the page last showed it.
  await store.updateSummary("pr-test", { body: "The assistant's newer summary", bodyAuthor: "agent" });
  expect(await submit("pr-test", undefined, undefined, comments, { body: "My summary", verdict: "COMMENT" }))
    .toEqual({ ok: false, error: expect.stringContaining("Draft changed · review it") });
  expect(await submit("pr-test", undefined, undefined, comments, { body: "The assistant's newer summary", verdict: "APPROVE" })).toMatchObject({ ok: false });
  expect(run).not.toHaveBeenCalled();
  expect(await submit("pr-test", undefined, undefined, comments, { body: "The assistant's newer summary", verdict: "COMMENT" })).toEqual({ ok: true });
});

test("a submitted review returns its link on GitHub", async () => {
  const { run, submit, page } = await setup();
  run.mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"headRefOid":"sha1"}' })
    .mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"id":12,"html_url":"https://github.com/acme/web/pull/7#pullrequestreview-12"}' });
  expect(await submit("pr-test", undefined, undefined, ...await page("pr-test"))).toEqual({ ok: true, url: "https://github.com/acme/web/pull/7#pullrequestreview-12" });
});

test("on your own PR, only a Comment review is submitted", async () => {
  const { store, run, submit, page } = await setup();
  await store.saveReview({ ...(await store.getReview("pr-test"))!, author: "Casey" });
  await store.setVerdict("pr-test", "APPROVE", "Ship it");
  // GitHub enforces it, so it stays, offering Submit as Comment.
  expect(await submit("pr-test", undefined, "casey", ...await page(), { force: true })).toEqual({ ok: false, error: "GitHub allows only a Comment review on your own PR.", offers: ["comment"] });
  expect(run).not.toHaveBeenCalledWith(expect.arrayContaining(["repos/acme/web/pulls/7/reviews"]), expect.anything());
  await store.setVerdict("pr-test", "COMMENT", "Notes to self");
  // Past that check, it goes on to sign in as casey.
  expect(await submit("pr-test", undefined, "casey", ...await page())).not.toMatchObject({ error: expect.stringContaining("own PR") });
});

test("a comment's severity goes to GitHub as its label, and a severity changed since the page showed it refuses", async () => {
  const { store, run, submit, page } = await setup();
  const at = { file: "a.ts", line: 1, side: "RIGHT" as const };
  await store.upsertDraftComment("pr-test", { ...at, severity: "blocking", body: "Please explain this" });
  expect(await submit("pr-test", undefined, undefined, [{ ...at, body: "Please explain this" }], (await page())[1])).toMatchObject({ ok: false, error: expect.stringContaining("Draft changed · review it") });
  expect(await submit("pr-test", undefined, undefined, [{ ...at, severity: "blocking", body: "Please explain this" }], (await page())[1])).toEqual({ ok: true });
  expect(JSON.parse(run.mock.lastCall![1]!.stdin!).comments).toEqual([{ ...{ path: "a.ts", line: 1, side: "RIGHT" }, body: "**Blocking:** Please explain this" }]);
});

test("submitReview without the comments, summary, and verdict the page shows is refused, and posts nothing", async () => {
  serverGh.mockReset();
  serverGh.mockImplementation(async (args: string[]) =>
    args.includes("token") ? { code: 0, stderr: "", stdout: "tok\n" }
    : args.includes(".login") ? { code: 0, stderr: "", stdout: "me\n" }
    : args[0] === "pr" ? { code: 0, stderr: "", stdout: JSON.stringify({ headRefOid: "sha1", state: "OPEN" }) }
    : { code: 0, stderr: "", stdout: JSON.stringify({ id: 1, node_id: "R_1", html_url: "https://github.com/acme/web/pull/1#r1", user: { login: "me" } }) });
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha1" });
  await store.savePatch("pr-1", patch);
  await store.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "Text the reviewer never saw" });
  const posts = () => serverGh.mock.calls.filter(([args]) => args.some((a: string) => a.includes("/reviews"))).length;
  // A local client that knows the revision and account but not what the page showed.
  const input = { targetKey: "pr-1", revision: await reviewRevision(store, "pr-1"), account: "me" };
  await expect(harness.behavior.callRpc("submitReview", input)).rejects.toThrow();
  const { comments, body, verdict } = await store.getDraft("pr-1");
  await expect(harness.behavior.callRpc("submitReview", { ...input, comments })).rejects.toThrow();
  expect(posts()).toBe(0);
  expect(await harness.behavior.callRpc("submitReview", { ...input, comments, body, verdict })).toMatchObject({ ok: true });
  expect(posts()).toBe(1);
});

/**
 * GitHub's side for the retry tests: the reviews it holds, and a POST that answers `result`, after creating the review
 * as "me" when `create` says so, as when gh fails or times out once GitHub has it. The reviews list returns them one
 * per line, as ghPrReviewsArgs asks.
 */
function github(store: AsyncStore, post: { create: boolean; result: Awaited<ReturnType<typeof runGh>> }, reviews: object[] = []) {
  let posts = 0;
  const run = vi.fn<typeof runGh>(async (args, options) => {
    if (args[0] === "auth") return { code: 0, stderr: "", stdout: "tok\n" };
    if (args[1] === "user") return { code: 0, stderr: "", stdout: "me\n" };
    if (args[0] === "pr") return { code: 0, stderr: "", stdout: '{"headRefOid":"sha1","state":"OPEN"}' };
    if (args.includes("--paginate")) return { code: 0, stderr: "", stdout: reviews.map((review) => JSON.stringify(review)).join("\n") };
    posts++;
    const sent = JSON.parse(options!.stdin!);
    if (post.create) reviews.push({ id: posts, node_id: `R_${posts}`, html_url: `https://github.com/acme/web/pull/7#pullrequestreview-${posts}`, user: { login: "Me" }, commit_id: sent.commit_id, body: sent.body, state: "COMMENTED", submitted_at: new Date().toISOString() });
    return post.result;
  });
  return { run, posts: () => posts, submit: createReviewSubmitter(store, run) };
}
const badGateway = { code: 1, stderr: "HTTP 502: Bad Gateway (https://api.github.com/repos/acme/web/pulls/7/reviews)", stdout: "" };
const timedOut = { code: 124, stderr: "gh timed out after 300s", stdout: "" };

test("a POST that fails after GitHub created the review finishes as that review, so it's never posted twice", async () => {
  const { store, page } = await setup();
  const gh = github(store, { create: true, result: badGateway });
  expect(await gh.submit("pr-test", undefined, "me", ...await page())).toEqual({ ok: true, url: "https://github.com/acme/web/pull/7#pullrequestreview-1" });
  expect(await store.getDraft("pr-test")).toMatchObject({ body: "", comments: [] });
  expect(await store.getReview("pr-test")).toMatchObject({ submittedVerdict: "COMMENT", submittedReviewId: "R_1", reviewer: "Me" });
  // Nothing is left to submit again.
  expect(await gh.submit("pr-test", undefined, "me", ...await page())).toMatchObject({ ok: false });
  expect(gh.posts()).toBe(1);
});

test("a POST that hangs gives up after five minutes, then finds the review it created", async () => {
  const { store, page } = await setup();
  const gh = github(store, { create: true, result: timedOut });
  expect(await gh.submit("pr-test", undefined, "me", ...await page())).toEqual({ ok: true, url: "https://github.com/acme/web/pull/7#pullrequestreview-1" });
  expect(gh.run.mock.calls.find(([args]) => args.includes("POST"))![1]).toMatchObject({ timeoutMs: 300_000 });
});

test("a failed POST keeps the draft when GitHub has no review from it: not an earlier one, another commit's, or someone else's", async () => {
  const { store, page } = await setup();
  const draft = await store.getDraft("pr-test");
  const mine = { node_id: "R_old", user: { login: "me" }, commit_id: "sha1", body: "My summary", state: "COMMENTED", submitted_at: new Date().toISOString() };
  const gh = github(store, { create: false, result: badGateway }, [
    { ...mine, submitted_at: new Date(Date.now() - 3_600_000).toISOString() },
    { ...mine, commit_id: "sha0" },
    { ...mine, user: { login: "alice" } },
    { ...mine, state: "APPROVED" },
    { ...mine, body: "An older summary" },
  ]);
  expect(await gh.submit("pr-test", undefined, "me", ...await page())).toEqual({ ok: false, error: "HTTP 502: Bad Gateway (https://api.github.com/repos/acme/web/pulls/7/reviews)" });
  expect(await store.getDraft("pr-test")).toEqual(draft);
});

// bug bash DFT-5: a review with the same verdict and summary, submitted from here a moment before, matched a failed POST.
test("a failed POST isn't taken for the review submitted from here a moment before, and keeps the draft", async () => {
  const { store, page } = await setup();
  const draft = await store.getDraft("pr-test");
  await store.setLifecycle("pr-test", { submittedVerdict: "COMMENT", submittedAt: Date.now() - 20_000, submittedHeadSha: "sha1", submittedReviewId: "R_0" });
  const first = { id: 0, node_id: "R_0", user: { login: "me" }, commit_id: "sha1", body: "My summary", state: "COMMENTED", submitted_at: new Date(Date.now() - 20_000).toISOString() };
  const refused = github(store, { create: false, result: badGateway }, [first]);
  expect(await refused.submit("pr-test", undefined, "me", ...await page())).toEqual({ ok: false, error: "HTTP 502: Bad Gateway (https://api.github.com/repos/acme/web/pulls/7/reviews)" });
  expect(await store.getDraft("pr-test")).toEqual(draft);
  // One GitHub did create is still found, past the earlier one.
  const created = github(store, { create: true, result: badGateway }, [first]);
  expect(await created.submit("pr-test", undefined, "me", ...await page())).toEqual({ ok: true, url: "https://github.com/acme/web/pull/7#pullrequestreview-1" });
  expect(await store.getReview("pr-test")).toMatchObject({ submittedReviewId: "R_1" });
  expect((await store.getDraft("pr-test")).comments).toEqual([]);
});

// bug bash verification 70-2: once the sync has read that earlier review back, it drops its id, and the failed POST
// matched it again.
test("a failed POST isn't taken for the review submitted from here once the sync has read it back", async () => {
  const { store, page } = await setup();
  const draft = await store.getDraft("pr-test");
  const at = Date.parse(new Date(Date.now() - 20_000).toISOString());
  // As the sync leaves it: GitHub's time for the review, and no id.
  await store.setLifecycle("pr-test", { submittedVerdict: "COMMENT", submittedAt: at, submittedHeadSha: "sha1", submittedReviewId: null, reviewer: "me" });
  const first = { id: 0, node_id: "R_0", user: { login: "me" }, commit_id: "sha1", body: "My summary", state: "COMMENTED", submitted_at: new Date(at).toISOString() };
  const refused = github(store, { create: false, result: badGateway }, [first]);
  expect(await refused.submit("pr-test", undefined, "me", ...await page())).toEqual({ ok: false, error: "HTTP 502: Bad Gateway (https://api.github.com/repos/acme/web/pulls/7/reviews)" });
  expect(await store.getDraft("pr-test")).toEqual(draft);
  const created = github(store, { create: true, result: badGateway }, [first]);
  expect(await created.submit("pr-test", undefined, "me", ...await page())).toEqual({ ok: true, url: "https://github.com/acme/web/pull/7#pullrequestreview-1" });
  expect((await store.getDraft("pr-test")).comments).toEqual([]);
});

test("when GitHub can't say whether a failed POST landed, Submit says to look at the PR first", async () => {
  const { store, page } = await setup();
  const gh = github(store, { create: false, result: timedOut });
  const answer = gh.run.getMockImplementation()!;
  gh.run.mockImplementation(async (args, options) => args.includes("--paginate") ? { code: 1, stderr: "HTTP 502", stdout: "" } : answer(args, options));
  expect(await gh.submit("pr-test", undefined, "me", ...await page())).toEqual({ ok: false, error: "gh timed out after 300s Couldn't check whether GitHub got your review anyway: look at the PR before you submit again. Your draft has been kept." });
  expect((await store.getDraft("pr-test")).comments).toHaveLength(1);
});

test("a submit blocked by a pending review started on github.com says how to clear it, keeping the draft", async () => {
  const { store, page } = await setup();
  const draft = await store.getDraft("pr-test");
  const gh = github(store, { create: false, result: {
    code: 1, stderr: "gh: Unprocessable Entity (HTTP 422)\n",
    stdout: JSON.stringify({ message: "Unprocessable Entity", errors: ["User can only have one pending review per pull request"], documentation_url: "https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request", status: "422" }),
  } });
  expect(await gh.submit("pr-test", undefined, "me", ...await page())).toEqual({ ok: false, error: "You have a pending review on this PR, started on github.com. Submit or discard it there, then submit again. Your draft has been kept.", offers: ["github"] });
  expect(await store.getDraft("pr-test")).toEqual(draft);
});

test("the page's Submit waits its turn in the line of writes to GitHub, and is never retried, even rate-limited", async () => {
  const { store, page } = await setup();
  const draft = await store.getDraft("pr-test");
  const gh = github(store, { create: false, result: {
    code: 1, stderr: "gh: You have exceeded a secondary rate limit. (HTTP 403)\n", stdout: JSON.stringify({ message: "You have exceeded a secondary rate limit." }),
  } });
  const writes = createGithubWrites();
  let release!: () => void;
  const reply = writes.pace(() => new Promise<void>((resolve) => { release = resolve; }));
  const submitted = createReviewSubmitter(store, gh.run, undefined, writes.pace)("pr-test", undefined, "me", ...await page());
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(gh.posts()).toBe(0);
  release();
  const replied = Date.now();
  await reply;
  expect(await submitted).toEqual({ ok: false, error: "GitHub is limiting how fast this account can post, and didn't say for how long. Wait a minute, then try again. (GitHub: You have exceeded a secondary rate limit.) Your draft has been kept." });
  expect(Date.now() - replied).toBeGreaterThanOrEqual(1_000);
  expect(gh.posts()).toBe(1);
  expect(await store.getDraft("pr-test")).toEqual(draft);
});

test("the page's Submit is refused at once, posting nothing, while GitHub has asked for longer than the page waits", async () => {
  const { store, page } = await setup();
  const gh = github(store, { create: true, result: { code: 0, stderr: "", stdout: "{}" } });
  const writes = createGithubWrites();
  const limited = vi.fn<typeof runGh>().mockResolvedValue({ code: 1, stderr: "gh: You have exceeded a secondary rate limit. (HTTP 403)", stdout: "HTTP/2.0 403 Forbidden\r\nRetry-After: 90\r\n\r\n{}" });
  await writes.post(limited, ["api", "-X", "POST", "repos/acme/web/pulls/7/comments/1/replies"], { budgetMs: 20_000 });
  const started = Date.now();
  expect(await createReviewSubmitter(store, gh.run, undefined, writes.pace)("pr-test", undefined, "me", ...await page()))
    .toEqual({ ok: false, error: "GitHub is limiting how fast this account can post. Try again in about 2 min. Your draft has been kept." });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(gh.posts()).toBe(0);
});

// Submission's last guards, each just before the POST.
const posted = (run: Awaited<ReturnType<typeof setup>>["run"]) => run.mock.calls.filter(([args]) => args.includes("POST")).length;

test("a review rebuilt while the PR's head was being checked isn't posted", async () => {
  const { store, run, submit, page } = await setup();
  run.mockImplementation(async (args) => {
    if (args[0] !== "pr") return { code: 0, stderr: "", stdout: '{"id":12}' };
    // The guide was rebuilt for a new head as GitHub answered.
    await store.saveReview({ ...(await store.getReview("pr-test"))!, headSha: "sha2" });
    return { code: 0, stderr: "", stdout: '{"headRefOid":"sha1"}' };
  });
  expect(await submit("pr-test", undefined, undefined, ...await page())).toEqual({ ok: false, error: "The review changed during submission. Wait for generation and review the draft again." });
  expect(posted(run)).toBe(0);
});

test("a diff that changed while the PR's head was being checked fails the revision check, and isn't posted", async () => {
  const { store, run, submit, page } = await setup();
  const revision = await reviewRevision(store, "pr-test");
  run.mockImplementation(async (args) => {
    if (args[0] !== "pr") return { code: 0, stderr: "", stdout: '{"id":12}' };
    await store.savePatch("pr-test", patch + "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n");
    return { code: 0, stderr: "", stdout: '{"headRefOid":"sha1"}' };
  });
  expect(await submit("pr-test", revision, undefined, ...await page())).toMatchObject({ ok: false });
  expect(posted(run)).toBe(0);
});

test("Request changes without a summary isn't posted", async () => {
  const { store, run, submit, page } = await setup();
  await store.setVerdict("pr-test", "REQUEST_CHANGES", "");
  expect(await submit("pr-test", undefined, undefined, ...await page())).toEqual({ ok: false, error: "Add a summary explaining the requested changes before submitting." });
  expect(run).not.toHaveBeenCalled();
});

test("a draft comment on a line outside the current diff isn't posted; under Submit anyway it moves into the summary", async () => {
  const { store, run, submit, page } = await setup();
  await store.upsertDraftComment("pr-test", { file: "a.ts", line: 9, side: "RIGHT", body: "Not in the diff" });
  expect(await submit("pr-test", undefined, undefined, ...await page())).toMatchObject({ ok: false, warning: "1 comment is outside the current diff (a.ts:9). Submitting anyway moves it into the summary.", warnings: ["outside-diff"] });
  expect(run.mock.calls.some(([args]) => args.includes("POST"))).toBe(false);
  expect(await submit("pr-test", undefined, undefined, ...await page(), { force: true })).toEqual({ ok: true });
  const payload = JSON.parse(run.mock.calls.find(([args]) => args.includes("POST"))![1]!.stdin!);
  expect(payload.comments.map((c: { line: number }) => c.line)).toEqual([1]);
  expect(payload.body).toBe("My summary\n\n- On `a.ts:9` (an earlier diff): Not in the diff");
});

test("what GitHub enforces still stops Submit anyway: a Request changes without a summary, a blank comment, an empty Comment", async () => {
  const { store, run, submit, page } = await setup();
  await store.setVerdict("pr-test", "REQUEST_CHANGES", "");
  expect(await submit("pr-test", undefined, undefined, ...await page(), { force: true })).toEqual({ ok: false, error: "Add a summary explaining the requested changes before submitting." });
  await store.setVerdict("pr-test", "COMMENT", "Notes");
  await store.upsertDraftComment("pr-test", { file: "a.ts", line: 1, side: "LEFT", body: " " });
  expect(await submit("pr-test", undefined, undefined, ...await page(), { force: true })).toEqual({ ok: false, error: "Draft comments can't be blank." });
  await store.deleteDraftComment("pr-test", { file: "a.ts", line: 1, side: "LEFT" });
  await store.deleteDraftComment("pr-test", { file: "a.ts", line: 1, side: "RIGHT" });
  await store.setVerdict("pr-test", "COMMENT", "");
  expect(await submit("pr-test", undefined, undefined, ...await page(), { force: true })).toEqual({ ok: false, error: "Add a summary or at least one comment before submitting a Comment review." });
  expect(run).not.toHaveBeenCalled();
});

test("a PR head GitHub doesn't say keeps the draft and posts nothing", async () => {
  const { store, run, submit, page } = await setup();
  const draft = await store.getDraft("pr-test");
  for (const stdout of ["{}", "not json", '{"headRefOid":""}']) {
    run.mockResolvedValueOnce({ code: 0, stderr: "", stdout });
    expect(await submit("pr-test", undefined, undefined, ...await page())).toEqual({ ok: false, error: "Couldn't verify the PR revision. Your draft has been kept." });
  }
  expect(posted(run)).toBe(0);
  expect(await store.getDraft("pr-test")).toEqual(draft);
});

test("on your own PR, a review GitHub took but this server didn't record is recorded on the next Submit, not posted again, and a sent comment stays", async () => {
  const { store, run, page } = await setup();
  await store.setLifecycle("pr-test", { ownPr: true });
  await store.upsertDraftComment("pr-test", { file: "a.ts", line: 1, side: "LEFT", body: "Sent to the main thread" });
  await store.trackComments("pr-test", [{ at: { file: "a.ts", line: 1, side: "LEFT" }, id: "c1", state: "sent", sendN: 1 }]);
  const receipts = postReceipts();
  // What GitHub took: the summary, and the one comment that posts.
  const draft = await store.getDraft("pr-test");
  await receipts.put(reviewReceiptKey("pr-test"), { submittedAt: 1, reviewId: "R1", headSha: "sha1", draft: { ...draft, comments: draft.comments.filter((c) => !c.state) } });
  expect(await createReviewSubmitter(store, run, receipts)("pr-test", undefined, undefined, ...await page("pr-test"))).toEqual({ ok: true });
  expect(run).not.toHaveBeenCalled();
  expect(await store.getDraft("pr-test")).toMatchObject({ body: "", comments: [{ id: "c1", state: "sent", body: "Sent to the main thread" }] });
});

test("only a Submit that may post holds its review: a Send waits for it, not for a check, as the review agent's form makes", async () => {
  const { store, run, page } = await setup();
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  run.mockImplementation(async (args) => {
    if (args[0] === "pr") await answered;
    return { code: 0, stderr: "", stdout: args[0] === "pr" ? '{"headRefOid":"sha1"}' : '{"id":12}' };
  });
  const submit = createReviewSubmitter(store, run);
  const [comments, summary] = await page("pr-test");
  const checking = submit("pr-test", undefined, undefined, comments, summary, { check: true });
  await vi.waitFor(() => expect(run).toHaveBeenCalled());
  expect(submit.submitting("pr-test")).toBe(false);
  const posting = submit("pr-test", undefined, undefined, comments, summary);
  expect(submit.submitting("pr-test")).toBe(true);
  answer();
  expect(await checking).toMatchObject({ ok: true });
  expect(await posting).toEqual({ ok: true });
  expect(submit.submitting("pr-test")).toBe(false);
});
