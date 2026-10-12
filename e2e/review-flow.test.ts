import { expect, test, vi } from "vitest";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../src/store";
import plugin from "../server";
import { runGh } from "../src/gh";

vi.mock("../src/gh", async (original) => ({ ...await original<typeof import("../src/gh")>(), runGh: vi.fn() }));

// The running BB supplies the real app shell and built plugin. Its plugin RPCs
// are routed through the official test host, with real SQLite and mocked GitHub
// and agent boundaries. No test review, comment or agent is sent to production.
test.skipIf(!process.env.BB_E2E_URL)("fullscreen verdict → submitted → reload → merge → archive, with in-plugin chat", async () => {
  let prState = "OPEN";
  let approved = false;
  vi.mocked(runGh).mockImplementation(async (args) => {
    if (args[0] === "auth") return { code: 0, stderr: "", stdout: "test-token" };
    if (args[1] === "user") return { code: 0, stderr: "", stdout: "reviewer" };
    if (args.includes("graphql")) return { code: 0, stderr: "", stdout: JSON.stringify({ data: { viewer: { login: "reviewer" }, repository: { pullRequest: { state: prState, headRefOid: "sha1", reviews: { nodes: approved ? [{ state: "APPROVED", submittedAt: new Date().toISOString(), author: { login: "reviewer" }, commit: { oid: "sha1" } }] : [] } } } } }) };
    if (args.includes("POST")) { approved = true; return { code: 0, stderr: "", stdout: '{"id":12}' }; }
    return { code: 0, stderr: "", stdout: JSON.stringify({ headRefOid: "sha1", state: prState }) };
  });
  let workerCount = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }),
    spawn: async () => ({ id: `e2e-hidden-agent-${++workerCount}` }),
    stop: async () => ({}), update: async () => ({}), archive: async () => ({}),
  } } });
  await plugin(bb);
  const store = createStore(bb);
  const key = "e2e-review";
  store.saveReview({ targetKey: key, kind: "pr", number: 7, repo: "acme/web", title: "Validate incoming review data", author: "alice", status: "ready", createdAt: Date.now(), headSha: "sha1", projectId: "test-project" });
  store.saveGuide(key, { title: "Validate incoming review data", intent: "Reject invalid values before they reach storage.", sections: [{ id: "validation", title: "Input validation", overview: "The entry point checks the value before saving it.", diffs: [{ file: "src/input.ts", description: "Reject blank values" }] }], unplacedFiles: [] } as any);
  store.savePatch(key, 'diff --git a/src/input.ts b/src/input.ts\n--- a/src/input.ts\n+++ b/src/input.ts\n@@ -1 +1,2 @@\n+if (!value.trim()) throw new Error("Required");\n save(value);\n');
  // Notes from before 0.6.0, when they had a tool of their own: Finish keeps them, in Stays in BB.
  store.saveReviewerNotes(key, "Private: verify the staged rollout.", 0);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dir = "docs/verification/2026-09-09";
  await mkdir(dir, { recursive: true });
  await page.route("**/api/v1/plugins/guided-review/rpc/*", async (route) => {
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
  const base = process.env.BB_E2E_URL!;
  // The review's commands: in BB's title bar, at the band's end in full screen, and in a phone's dock.
  const commands = page.getByRole("group", { name: "Review commands" });
  try {
    await page.goto(`${base}/plugins/guided-review/review/settings/${key}`);
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
    // A first open shows the Overview; reading starts at chapter 1.
    await page.getByRole("button", { name: /^Start reading: Input validation/ }).click();
    // Comments, docked beside the code; it stays closed or open across a reload.
    await commands.getByRole("button", { name: "Comments", exact: true }).click();
    const side = page.getByRole("complementary", { name: "Comments and agent", exact: true });
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
    expect(store.getDraft(key).comments).toHaveLength(1);
    await page.screenshot({ animations: "disabled", path: `${dir}/comments-desktop.png` });
    await commands.getByRole("button", { name: "Comments", exact: true }).click();
    await side.waitFor({ state: "hidden" });
    await page.reload();
    await page.getByRole("article", { name: "Draft comment on src/input.ts:1", exact: true }).waitFor();
    expect(await side.isVisible()).toBe(false);
    // The title bar's tooltips name the keys.
    await commands.getByRole("button", { name: "Comments", exact: true }).focus();
    await page.getByRole("tooltip", { name: "Comments (c)", exact: true }).waitFor();
    // Finish review: the summary, the verdict, and what goes to GitHub.
    await commands.getByRole("button", { name: /^Submit review/ }).click();
    const summary = page.getByRole("region", { name: "Review summary", exact: true });
    await summary.getByRole("button", { name: "Write summary", exact: true }).click();
    await summary.getByRole("textbox", { name: "Review summary", exact: true }).fill("The validation looks good with this test follow-up.");
    await summary.getByRole("button", { name: "Save summary", exact: true }).click();
    await summary.getByText("The validation looks good with this test follow-up.", { exact: true }).waitFor();
    expect(store.getDraft(key).body).toBe("The validation looks good with this test follow-up.");
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
    expect(store.getReviewerNotes(key).body).toBe("Private: verify the staged rollout, then the cache.");
    await page.screenshot({ animations: "disabled", path: `${dir}/finish-desktop.png` });
    // A phone: Finish is inside the Comments sheet, above the dock.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await commands.getByRole("button", { name: /^Comments, 1 not submitted/ }).click();
    await page.getByRole("complementary", { name: "Comments", exact: true }).getByRole("button", { name: "Finish review", exact: true }).click();
    await verdicts.waitFor();
    await verdicts.getByRole("button", { name: "Approve", exact: true }).scrollIntoViewIfNeeded();
    expect(await verdicts.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    // One row of verdicts, and Submit pinned below the draft, in view.
    expect(new Set(await verdicts.getByRole("button").evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().top)))).size).toBe(1);
    const submit = await page.getByRole("button", { name: /^Submit to GitHub/ }).boundingBox();
    expect(submit && submit.y >= 0 && submit.y + submit.height <= 844).toBe(true);
    await page.screenshot({ animations: "disabled", path: `${dir}/review-mobile.png` });
    await page.getByRole("complementary", { name: "Finish review", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await verdicts.waitFor({ state: "hidden" });
    // Closed, the sheet leaves the dock: one 52px bar under the code.
    expect(await commands.isVisible()).toBe(true);
    expect(await commands.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(53);
    await page.screenshot({ animations: "disabled", path: `${dir}/dock-mobile.png` });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await commands.getByRole("button", { name: /^Submit review/ }).click();
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
    expect(store.getReview(key)?.submittedVerdict).toBe("APPROVE");
    expect(store.getDraft(key).comments).toHaveLength(0);
    expect(store.getReviewerNotes(key).body).toBe("Private: verify the staged rollout, then the cache.");
    const submission = vi.mocked(runGh).mock.calls.find(([args]) => args.includes("POST"));
    expect(submission?.[1]?.stdin).not.toContain("Private:");
    expect(submission?.[1]?.stdin).toContain("Please test whitespace-only input too.");
    expect(submission?.[1]?.stdin).toContain("The validation looks good with this test follow-up.");
    // In full screen, the commands sit at the band's end.
    const askAgent = commands.getByRole("button", { name: "Ask agent", exact: true });
    await askAgent.click();
    const assistant = page.getByRole("region", { name: "Review agent", exact: true });
    await assistant.waitFor();
    expect(await page.getByRole("dialog", { name: "Review agent", exact: true }).count()).toBe(0);
    await page.getByPlaceholder(/Ask the agent/).fill("Explain the validation guard");
    await askAgent.click();
    await assistant.waitFor({ state: "hidden" });
    await askAgent.focus();
    const assistantTooltip = page.getByRole("tooltip", { name: "Ask agent (a)", exact: true });
    await assistantTooltip.waitFor();
    expect(await assistantTooltip.evaluate((element) => document.fullscreenElement?.contains(element))).toBe(true);
    await askAgent.press("Enter");
    expect(await page.getByRole("textbox", { name: "Ask the agent", exact: true }).inputValue()).toBe("Explain the validation guard");
    await page.getByRole("button", { name: "Pop out", exact: true }).click();
    const widget = page.getByRole("dialog", { name: "Review agent", exact: true });
    await widget.waitFor();
    expect(await widget.evaluate((element) => document.fullscreenElement?.contains(element))).toBe(true);
    expect(await widget.getByRole("textbox", { name: "Ask the agent", exact: true }).inputValue()).toBe("Explain the validation guard");
    await page.screenshot({ animations: "disabled", path: `${dir}/assistant-widget.png` });
    await widget.getByRole("button", { name: "Dock", exact: true }).click();
    // Switching the panel to Comments and back keeps the message.
    await commands.getByRole("button", { name: "Comments", exact: true }).click();
    await askAgent.click();
    expect(await page.getByRole("textbox", { name: "Ask the agent", exact: true }).inputValue()).toBe("Explain the validation guard");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // bb's ThreadChat takes over. The stubbed worker id has no thread in this bb.
    await assistant.getByText("This thread is no longer available.").waitFor();
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ visibility: "hidden", title: `Review agent: ${key}`, pluginMetadata: { targetKey: key },
      input: [{ type: "text", text: "Explain the validation guard\n\nAbout `src/input.ts`." }] });
    expect(JSON.stringify(harness.inspection.sdk.callsTo("threads.spawn"))).not.toContain("Private: verify");
    await page.screenshot({ animations: "disabled", path: `${dir}/assistant-panel.png` });
    expect(await page.getByText("Open as thread", { exact: true }).count()).toBe(0);
    await page.evaluate(() => document.exitFullscreen());
    // A docked panel opens again where it was.
    await page.reload();
    await assistant.waitFor();
    await commands.getByRole("button", { name: /^Submit review/ }).click();
    await page.getByRole("region", { name: "Submitted review" }).waitFor();
    await page.getByText("Private notes", { exact: true }).click();
    expect(await page.getByRole("textbox", { name: "Private notes", exact: true }).inputValue()).toBe("Private: verify the staged rollout, then the cache.");
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
    expect(store.getReview(key)?.archivedAt).toBeTypeOf("number");
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
    expect(await commands.getByRole("button", { name: /^Submit review/ }).count()).toBe(0);
    await commands.getByRole("button", { name: "Review actions", exact: true }).click();
    expect(await page.getByRole("button", { name: /^(Update|Rebuild) guide$/ }).count()).toBe(0);
    await page.keyboard.press("Escape");
    await askAgent.click();
    await assistant.getByText("This thread is no longer available.").waitFor();
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    // A phone opens its sheets only from the dock.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await commands.getByRole("button", { name: "Ask agent", exact: true }).click();
    await assistant.getByText("This thread is no longer available.").waitFor();
    expect(await assistant.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: `${dir}/assistant-mobile.png` });
    await page.getByRole("complementary", { name: "Review agent", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
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
