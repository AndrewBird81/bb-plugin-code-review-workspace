import { expect, test, vi } from "vitest";
import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../src/store";
import plugin from "../server";
import { runGh } from "../src/gh";
import { loopbackUrl } from "./loopback";
import { queueStore } from "../src/store-queue";
import { MARK_PART } from "../src/agent-chat.test-support";

vi.mock("../src/gh", async (original) => ({ ...await original<typeof import("../src/gh")>(), runGh: vi.fn() }));

/** BB keeps its side panel open or closed on the server, across sessions: each test starts with it closed. */
async function hideBbPanel(page: Page) {
  const hide = page.getByRole("button", { name: /^Hide right panel/ }).first();
  await hide.waitFor({ timeout: 3000 }).then(() => hide.click()).catch(() => {});
}

// The running BB supplies the real app shell and built plugin. Its plugin RPCs
// are routed through the official test host, with real SQLite and mocked GitHub
// and agent boundaries. No test review, comment or agent is sent to production.
test.skipIf(!process.env.BB_E2E_URL)("fullscreen verdict → submitted → reload → merge → archive, with the review agent in BB's side panel", async () => {
  const base = loopbackUrl("BB_E2E_URL", process.env.BB_E2E_URL!);
  let prState = "OPEN";
  let approved = false;
  vi.mocked(runGh).mockImplementation(async (args) => {
    if (args[0] === "auth") return { code: 0, stderr: "", stdout: "test-token" };
    if (args[1] === "user") return { code: 0, stderr: "", stdout: "reviewer" };
    // The review sync's batched PR facts (src/github/pr-facts.ts), one alias per PR.
    if (args.some((arg) => arg.includes("p0:repository"))) return { code: 0, stderr: "", stdout: JSON.stringify({ data: { p0: { pullRequest: { number: 7, state: prState, mergedAt: prState === "MERGED" ? new Date().toISOString() : null, headRefOid: "sha1", author: { login: "alice" }, reviews: { nodes: approved ? [{ id: "review-12", state: "APPROVED", submittedAt: new Date().toISOString(), body: "", commit: { oid: "sha1" } }] : [] } } } } }) };
    if (args.includes("graphql")) return { code: 0, stderr: "", stdout: JSON.stringify({ data: { viewer: { login: "reviewer" }, repository: { pullRequest: { state: prState, headRefOid: "sha1", reviews: { nodes: approved ? [{ state: "APPROVED", submittedAt: new Date().toISOString(), author: { login: "reviewer" }, commit: { oid: "sha1" } }] : [] } } } } }) };
    if (args.includes("POST")) { approved = true; return { code: 0, stderr: "", stdout: '{"id":12}' }; }
    return { code: 0, stderr: "", stdout: JSON.stringify({ headRefOid: "sha1", state: prState }) };
  });
  let workerCount = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }),
    spawn: async () => ({ id: `e2e-hidden-agent-${++workerCount}` }),
    stop: async () => ({}), update: async () => ({}), archive: async () => ({}),
  }, projects: { defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }) } } });
  await plugin(bb);
  const store = queueStore(createStore(bb));
  const key = "e2e-review";
  await store.saveReview({ targetKey: key, kind: "pr", number: 7, repo: "acme/web", title: "Validate incoming review data", author: "alice", status: "ready", createdAt: Date.now(), headSha: "sha1", projectId: "test-project" });
  await store.saveGuide(key, { title: "Validate incoming review data", intent: "Reject invalid values before they reach storage.", sections: [{ id: "validation", title: "Input validation", overview: "The entry point checks the value before saving it.", diffs: [{ file: "src/input.ts", description: "Reject blank values" }] }], unplacedFiles: [] } as any);
  await store.savePatch(key, 'diff --git a/src/input.ts b/src/input.ts\n--- a/src/input.ts\n+++ b/src/input.ts\n@@ -1 +1,2 @@\n+if (!value.trim()) throw new Error("Required");\n save(value);\n');
  // Notes from before 0.6.0, when they had a tool of their own: Finish keeps them, in Stays in BB.
  await store.saveReviewerNotes(key, "Private: verify the staged rollout.", 0);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dir = "docs/verification/2026-09-09";
  await mkdir(dir, { recursive: true });
  await page.route("**/api/v1/plugins/code-review-workspace/rpc/*", async (route) => {
    const method = new URL(route.request().url()).pathname.split("/").pop()!;
    const input = route.request().postDataJSON();
    const helpers: Record<string, unknown> = {
      getSetupStatus: { account: "reviewer", githubCli: true, agentAvailable: true, projectAvailable: true },
      getGhAccounts: { active: "reviewer", accounts: [{ login: "reviewer", active: true }] },
      getChecks: { bucket: "none", checks: [] }, checkRepoAccess: { accessible: true, repo: "acme/web", account: "reviewer" },
    };
    try {
      const result = helpers[method] ?? await harness.behavior.callRpc(method, input);
      await route.fulfill({ json: { ok: true, result } });
    } catch (error) { await route.fulfill({ status: 500, json: { ok: false, error: { message: String(error) } } }); }
  });
  // The review's commands: in BB's title bar, at the band's end in full screen, and in a phone's dock.
  const commands = page.getByRole("group", { name: "Review commands" });
  try {
    await page.goto(`${base}/plugins/code-review-workspace/review/settings/${key}`);
    // Collapse the unrelated Office overlay through its normal, browser-local control.
    // Otherwise it can cover the plugin's editors in the shared BB test shell.
    const collapseOffice = page.getByRole("button", { name: "Collapse office to current worker", exact: true });
    await collapseOffice.waitFor({ timeout: 5000 }).then(() => collapseOffice.click()).catch(() => {});
    await page.getByRole("textbox", { name: "Guide instructions", exact: true }).fill("Explain compatibility and migrations.");
    await page.getByRole("textbox", { name: "Assistant instructions", exact: true }).fill("Focus on concrete failure cases.");
    await page.getByRole("button", { name: "Detailed", exact: true }).click();
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByText("Settings saved", { exact: true }).waitFor();
    await page.reload();
    await page.getByRole("textbox", { name: "Guide instructions", exact: true }).waitFor();
    expect(await page.getByRole("textbox", { name: "Guide instructions", exact: true }).inputValue()).toBe("Explain compatibility and migrations.");
    await page.screenshot({ animations: "disabled", path: `${dir}/settings-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole("textbox", { name: "Guide instructions", exact: true }).waitFor();
    expect(await page.getByRole("textbox", { name: "Guide instructions", exact: true }).evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: `${dir}/settings-mobile.png` });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Back to review", exact: true }).click();
    await hideBbPanel(page);
    // A first open shows the Overview; reading starts at chapter 1.
    await page.getByRole("button", { name: /^Start reading: Input validation/ }).click();
    // Comments, docked beside the code; it stays closed or open across a reload.
    await commands.getByRole("button", { name: "Comments", exact: true }).click();
    const side = page.getByRole("complementary", { name: "Comments and Finish review", exact: true });
    expect(await side.evaluate((element) => element.getBoundingClientRect().width)).toBe(400);
    await page.getByRole("button", { name: "Comment options", exact: true }).click();
    await page.getByRole("button", { name: "Add comment by line…", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Comment line", exact: true }).fill("1");
    await page.getByRole("textbox", { name: "Draft comment", exact: true }).fill("Please cover blank input in a test.");
    await page.getByRole("button", { name: "Add to draft", exact: true }).click();
    const list = page.getByRole("region", { name: "Comments", exact: true });
    await list.getByText("Please cover blank input in a test.", { exact: true }).waitFor();
    // The diff shows the comment under its line too, with its actions.
    const inline = page.getByRole("article", { name: "Draft comment on src/input.ts:1", exact: true });
    await inline.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Draft comment", exact: true }).fill("Please test whitespace-only input too.");
    await page.getByRole("button", { name: "Save comment", exact: true }).click();
    await list.getByText("Please test whitespace-only input too.", { exact: true }).waitFor();
    await inline.getByText("Please test whitespace-only input too.", { exact: true }).waitFor();
    expect((await store.getDraft(key)).comments).toHaveLength(1);
    await page.screenshot({ animations: "disabled", path: `${dir}/comments-desktop.png` });
    await commands.getByRole("button", { name: "Comments", exact: true }).click();
    await side.waitFor({ state: "hidden" });
    await page.reload();
    await page.getByRole("article", { name: "Draft comment on src/input.ts:1", exact: true }).waitFor();
    expect(await side.isVisible()).toBe(false);
    // The title bar's tooltips name the keys, on keyboard focus.
    await page.keyboard.press("Tab");
    await commands.getByRole("button", { name: "Comments", exact: true }).focus();
    await page.getByRole("tooltip", { name: "Comments (c)", exact: true }).waitFor();
    // Finish review: the summary, the verdict, and what goes to GitHub.
    await commands.getByRole("button", { name: /^Finish review:/ }).click();
    const summary = page.getByRole("region", { name: "Review summary", exact: true });
    await summary.getByRole("button", { name: "Write summary", exact: true }).click();
    await summary.getByRole("textbox", { name: "Review summary", exact: true }).fill("The validation looks good with this test follow-up.");
    await summary.getByRole("button", { name: "Save summary", exact: true }).click();
    await summary.getByText("The validation looks good with this test follow-up.", { exact: true }).waitFor();
    expect((await store.getDraft(key)).body).toBe("The validation looks good with this test follow-up.");
    const verdicts = page.getByRole("group", { name: "Review verdict" });
    await verdicts.getByRole("button", { name: "Approve", exact: true }).waitFor();
    expect(await page.getByRole("combobox", { name: "Review verdict" }).count()).toBe(0);
    // Private notes stay in BB: readable and editable in Finish, never sent.
    await page.getByText("Private notes", { exact: true }).click();
    const notes = page.getByRole("textbox", { name: "Private notes", exact: true });
    expect(await notes.inputValue()).toBe("Private: verify the staged rollout.");
    await notes.fill("Private: verify the staged rollout, then the cache.");
    await notes.blur();
    await page.getByText("Notes saved", { exact: true }).waitFor();
    expect((await store.getReviewerNotes(key)).body).toBe("Private: verify the staged rollout, then the cache.");
    await page.screenshot({ animations: "disabled", path: `${dir}/finish-desktop.png` });
    // A phone: Finish is inside the Comments sheet, above the dock.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await commands.getByRole("button", { name: "Comments, 1 to send", exact: true }).click();
    await page.getByRole("dialog", { name: "Comments", exact: true }).getByRole("button", { name: "Finish review", exact: true }).click();
    await verdicts.waitFor();
    await verdicts.getByRole("button", { name: "Approve", exact: true }).scrollIntoViewIfNeeded();
    expect(await verdicts.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    // One row of verdicts, and Submit pinned below the draft, in view.
    expect(new Set(await verdicts.getByRole("button").evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().top)))).size).toBe(1);
    const submit = await page.getByRole("button", { name: /^Submit to GitHub/ }).boundingBox();
    expect(submit && submit.y >= 0 && submit.y + submit.height <= 844).toBe(true);
    await page.screenshot({ animations: "disabled", path: `${dir}/review-mobile.png` });
    await page.getByRole("dialog", { name: "Finish review", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await verdicts.waitFor({ state: "hidden" });
    // Closed, the sheet leaves the dock: one 52px bar under the code.
    expect(await commands.isVisible()).toBe(true);
    expect(await commands.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(53);
    await page.screenshot({ animations: "disabled", path: `${dir}/dock-mobile.png` });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await commands.getByRole("button", { name: /^Finish review:/ }).click();
    await verdicts.waitFor();
    await commands.getByRole("button", { name: "Full screen", exact: true }).click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    expect(await verdicts.evaluate((element) => document.fullscreenElement?.contains(element))).toBe(true);
    await verdicts.getByRole("button", { name: "Request changes", exact: true }).click();
    expect(await verdicts.getByRole("button", { name: "Request changes", exact: true }).getAttribute("aria-pressed")).toBe("true");
    await verdicts.getByRole("button", { name: "Comment", exact: true }).click();
    await verdicts.getByRole("button", { name: "Approve", exact: true }).click();
    expect(await verdicts.getByRole("button", { name: "Approve", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(await verdicts.getByRole("button", { name: "Comment", exact: true }).getAttribute("aria-pressed")).toBe("false");
    await page.screenshot({ animations: "disabled", path: `${dir}/fullscreen-verdict.png` });
    await page.getByRole("button", { name: /^Submit to GitHub/ }).click();
    await page.getByRole("region", { name: "Submitted review" }).waitFor();
    expect((await store.getReview(key))?.submittedVerdict).toBe("APPROVE");
    expect((await store.getDraft(key)).comments).toHaveLength(0);
    expect((await store.getReviewerNotes(key)).body).toBe("Private: verify the staged rollout, then the cache.");
    const submission = vi.mocked(runGh).mock.calls.find(([args]) => args.includes("POST"));
    expect(submission?.[1]?.stdin).not.toContain("Private:");
    expect(submission?.[1]?.stdin).toContain("Please test whitespace-only input too.");
    expect(submission?.[1]?.stdin).toContain("The validation looks good with this test follow-up.");
    // In full screen, the commands sit at the band's end; Ask agent leaves full screen for BB's side panel.
    const askAgent = commands.getByRole("button", { name: "Ask agent", exact: true });
    await askAgent.click();
    await page.waitForFunction(() => !document.fullscreenElement);
    const assistant = page.getByRole("region", { name: "Review agent", exact: true });
    await assistant.waitFor();
    // In BB's panel, not the review's: its own panel stays Comments' and Finish review's.
    expect(await page.getByRole("complementary", { name: "Comments and Finish review", exact: true }).getByRole("region", { name: "Review agent" }).count()).toBe(0);
    expect(await askAgent.getAttribute("aria-pressed")).toBe("true");
    await page.getByPlaceholder(/Ask the agent/).fill("Explain the validation guard");
    await askAgent.click();
    await assistant.waitFor({ state: "hidden" });
    await page.keyboard.press("Tab");
    await askAgent.focus();
    await page.getByRole("tooltip", { name: "Ask agent (a)", exact: true }).waitFor();
    await askAgent.press("Enter");
    // BB keeps the tab while its panel is closed: the message is still there.
    expect(await page.getByRole("textbox", { name: "Ask the agent", exact: true }).inputValue()).toBe("Explain the validation guard");
    await page.screenshot({ animations: "disabled", path: `${dir}/assistant-tab.png` });
    // Comments beside it, and the agent's message kept.
    await commands.getByRole("button", { name: "Comments", exact: true }).click();
    expect(await page.getByRole("textbox", { name: "Ask the agent", exact: true }).inputValue()).toBe("Explain the validation guard");
    await page.screenshot({ animations: "disabled", path: `${dir}/assistant-tab-comments.png` });
    await commands.getByRole("button", { name: "Comments", exact: true }).click();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // bb's ThreadChat takes over. The stubbed worker id has no thread in this bb.
    await assistant.getByText("This thread is no longer available.").waitFor();
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ visibility: "hidden", title: `Review agent: web#7 · Validate incoming review data · ${key}`, pluginMetadata: { targetKey: key },
      input: [{ type: "text", text: "Explain the validation guard\n\nAbout `src/input.ts`." }, MARK_PART] });
    expect(JSON.stringify(harness.inspection.sdk.callsTo("threads.spawn"))).not.toContain("Private: verify");
    await page.screenshot({ animations: "disabled", path: `${dir}/assistant-panel.png` });
    expect(await page.getByText("Open as thread", { exact: true }).count()).toBe(0);
    // BB's panel opens again where it was.
    await page.reload();
    await assistant.waitFor();
    // Nothing left to submit, so the title bar has no Finish review: Comments' foot opens the submitted review.
    expect(await commands.getByRole("button", { name: /^Finish review:/ }).count()).toBe(0);
    await commands.getByRole("button", { name: "Comments", exact: true }).click();
    // Beside BB's open panel, the review is narrower than Comments docks in, so Comments is over the code.
    await page.getByRole("dialog", { name: "Comments", exact: true }).getByRole("button", { name: "Finish review", exact: true }).click();
    await page.getByRole("region", { name: "Submitted review" }).waitFor();
    await page.getByText("Private notes", { exact: true }).click();
    expect(await page.getByRole("textbox", { name: "Private notes", exact: true }).inputValue()).toBe("Private: verify the staged rollout, then the cache.");
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    await page.getByRole("button", { name: "All reviews", exact: true }).click();
    await page.getByText("Nothing needs you right now", { exact: true }).waitFor();
    await page.getByRole("button", { name: /^Reviewed/ }).click();
    await page.getByText(/^You approved/).waitFor();
    await page.screenshot({ animations: "disabled", path: `${dir}/reviewed-desktop.png` });
    prState = "MERGED";
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    const archive = page.getByRole("region", { name: "Archive", exact: true });
    const archiveHeader = archive.getByRole("button", { name: /^Archive/ });
    await archiveHeader.waitFor();
    expect(await page.getByRole("button", { name: /^Reviewed/ }).count()).toBe(0);
    expect((await store.getReview(key))?.archivedAt).toBeTypeOf("number");
    // bb cannot send to an archived thread, so the assistant chat stays unarchived.
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    await archiveHeader.click();
    await archive.getByText("Merged", { exact: true }).waitFor();
    await page.screenshot({ animations: "disabled", path: `${dir}/archive-desktop.png` });
    await archive.getByRole("button", { name: /Validate incoming review data/ }).click();
    // Nothing to submit or rebuild: Comments' foot opens the archived review, with its unsubmitted draft and notes.
    const comments = commands.getByRole("button", { name: "Comments", exact: true });
    await comments.waitFor();
    if (await comments.getAttribute("aria-pressed") !== "true") await comments.click();
    await page.getByRole("button", { name: "Open the archived review", exact: true }).click();
    await page.getByRole("region", { name: "Archived review" }).waitFor();
    expect(await page.getByRole("button", { name: /^Submit to GitHub/ }).count()).toBe(0);
    expect(await commands.getByRole("button", { name: /^Finish review:/ }).count()).toBe(0);
    await commands.getByRole("button", { name: "Review actions", exact: true }).click();
    expect(await page.getByRole("button", { name: /^(Update|Rebuild) guide$/ }).count()).toBe(0);
    await page.keyboard.press("Escape");
    if (await askAgent.getAttribute("aria-pressed") !== "true") await askAgent.click();
    await assistant.getByText("This thread is no longer available.").waitFor();
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    // A phone: the dock's Ask agent opens BB's panel over the page.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await hideBbPanel(page);
    await commands.getByRole("button", { name: "Ask agent", exact: true }).click();
    await assistant.getByText("This thread is no longer available.").waitFor();
    expect(await assistant.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: `${dir}/assistant-mobile.png` });
    await hideBbPanel(page);
    await commands.getByRole("button", { name: "All reviews", exact: true }).click();
    await page.reload();
    await archiveHeader.waitFor();
    if (await archiveHeader.getAttribute("aria-expanded") === "false") await archiveHeader.click();
    await archive.getByText("Merged", { exact: true }).waitFor();
    await page.screenshot({ animations: "disabled", path: `${dir}/archive-mobile.png` });
    expect(await archive.evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    expect(vi.mocked(runGh).mock.calls.filter(([args]) => args.includes("POST"))).toHaveLength(1);
  } finally { await browser.close(); await harness.lifecycle.dispose(); }
}, 60_000);

// The loop on a local review (notes/design/E7-plan.md QA 3): Send 3 to the main thread, which reports each, then Resolve
// 2 and Reopen 1 on their cards; the next Send carries only the one reopened.
test.skipIf(!process.env.BB_E2E_URL)("Send 3 → reports → Resolve 2 / Reopen 1 → the next Send carries 1", async () => {
  const base = loopbackUrl("BB_E2E_URL", process.env.BB_E2E_URL!);
  vi.mocked(runGh).mockImplementation(async () => ({ code: 1, stderr: "no GitHub here", stdout: "" }));
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    get: async ({ threadId }: { threadId: string }) => ({ id: threadId, title: "Retry uploads", titleFallback: null, archivedAt: null, deletedAt: null, environmentId: null, status: "idle", visibility: "visible", originPluginId: null }),
    send: async () => ({ ok: true, delivery: "sent" }),
    experimental_listAncestors: async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((threadId) => ({ threadId, ancestorIds: [] })) }),
    stop: async () => ({}), update: async () => ({}), archive: async () => ({}),
  }, projects: { defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }) } } as any });
  await plugin(bb);
  const store = queueStore(createStore(bb));
  const key = "e2e-loop";
  await store.saveReview({ targetKey: key, kind: "ref", gitRef: "main...retry-uploads", title: "Retry uploads", status: "ready", createdAt: Date.now(), projectId: "test-project" });
  await store.setLifecycle(key, { sourceThreadId: "coder", sourceThreadAt: Date.now() });
  await store.saveGuide(key, { title: "Retry uploads", intent: "Retry a failed upload.", sections: [{ id: "retry", title: "Retries", overview: "Uploads retry.", diffs: [{ file: "src/upload.ts", description: "Retry" }] }], unplacedFiles: [] } as any);
  await store.savePatch(key, "diff --git a/src/upload.ts b/src/upload.ts\n--- a/src/upload.ts\n+++ b/src/upload.ts\n@@ -0,0 +1,3 @@\n+const tries = 3;\n+const wait = 100;\n+retry(upload, tries, wait);\n");
  for (const line of [1, 2, 3]) await store.upsertDraftComment(key, { file: "src/upload.ts", line, side: "RIGHT", body: `Fix line ${line}.` });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/plugins/code-review-workspace/rpc/*", async (route) => {
    const method = new URL(route.request().url()).pathname.split("/").pop()!;
    const helpers: Record<string, unknown> = {
      getSetupStatus: { account: "reviewer", githubCli: true, agentAvailable: true, projectAvailable: true },
      getGhAccounts: { active: "reviewer", accounts: [{ login: "reviewer", active: true }] },
      getChecks: { bucket: "none", checks: [] },
    };
    try {
      const result = helpers[method] ?? await harness.behavior.callRpc(method, route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, result } });
    } catch (error) { await route.fulfill({ status: 500, json: { ok: false, error: { message: String(error) } } }); }
  });
  /** What the main thread was sent, oldest first. */
  const sent = () => harness.inspection.sdk.callsTo("threads.send").map(([args]) => (args as { input: Array<{ text: string }> }).input[0]!.text);
  const card = (line: number) => page.getByRole("article", { name: `Draft comment on src/upload.ts:${line}`, exact: true });
  /** Finish review's Send, all it offers. */
  async function sendAll(count: number) {
    const comments = page.getByRole("group", { name: "Review commands" }).getByRole("button", { name: "Comments", exact: true });
    if (await comments.getAttribute("aria-pressed") !== "true") await comments.click();
    await page.getByRole("complementary", { name: "Comments and Finish review", exact: true }).getByRole("button", { name: "Finish review", exact: true }).click();
    await page.getByRole("button", { name: `Send ${count} to main thread`, exact: true }).click();
    await page.getByRole("group", { name: "Comments to send", exact: true }).getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("region", { name: "Send to the main thread", exact: true }).getByText(`Sent ${count} comment${count === 1 ? "" : "s"} to Retry uploads.`).waitFor();
  }
  try {
    await page.goto(`${base}/plugins/code-review-workspace/review/${key}`);
    await hideBbPanel(page);
    const collapseOffice = page.getByRole("button", { name: "Collapse office to current worker", exact: true });
    await collapseOffice.waitFor({ timeout: 5000 }).then(() => collapseOffice.click()).catch(() => {});
    await page.getByRole("button", { name: /^Start reading: Retries/ }).click();
    await card(1).waitFor();
    await sendAll(3);
    expect(sent()).toHaveLength(1);
    for (const id of ["c1", "c2", "c3"]) expect(sent()[0]).toContain(id);
    // The main thread reports each.
    for (const [id, outcome] of [["c1", "done"], ["c2", "done"], ["c3", "declined"]]) {
      expect(await harness.behavior.runCli(["report", id!, outcome!, "--note", `Note on ${id}.`], { threadId: "coder", projectId: "test-project" })).toMatchObject({ exitCode: 0 });
    }
    await page.reload();
    await card(1).getByText("Done · Note on c1").waitFor();
    await card(1).getByRole("button", { name: "Resolve", exact: true }).click();
    await card(1).getByText("Resolved", { exact: true }).waitFor();
    await card(2).getByRole("button", { name: "Resolve", exact: true }).click();
    await card(2).getByText("Resolved", { exact: true }).waitFor();
    await card(3).getByRole("button", { name: "Reopen", exact: true }).click();
    await card(3).getByText("Open", { exact: true }).waitFor();
    await page.screenshot({ animations: "disabled", path: "docs/verification/2026-09-09/fix-cards-desktop.png" });
    expect((await store.getDraft(key)).comments.map((comment) => [comment.id, comment.state])).toEqual([["c1", "resolved"], ["c2", "resolved"], ["c3", "open"]]);
    // The next Send carries the one reopened, by its id.
    await sendAll(1);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toContain("c3");
    expect(sent()[1]).not.toMatch(/\bc[12]\b/);
    expect((await store.getDraft(key)).comments.map((comment) => [comment.id, comment.state, comment.sendN])).toEqual([["c1", "resolved", 1], ["c2", "resolved", 1], ["c3", "sent", 2]]);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await harness.lifecycle.dispose(); }
}, 60_000);
