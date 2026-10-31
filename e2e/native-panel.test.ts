import { expect, test, vi } from "vitest";
import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../src/store";
import plugin from "../server";
import { runGh } from "../src/gh";
import { loopbackUrl } from "./loopback";
import { queueStore } from "../src/store-queue";

vi.mock("../src/gh", async (original) => ({ ...await original<typeof import("../src/gh")>(), runGh: vi.fn() }));

/** BB keeps its side panel open or closed on the server, across sessions: the test starts with it closed. */
async function hideBbPanel(page: Page) {
  const hide = page.getByRole("button", { name: /^Hide right panel/ }).first();
  await hide.waitFor({ timeout: 3000 }).then(() => hide.click()).catch(() => {});
}

// Doing and reviewing: a review's Main thread ↗ and its tab in BB's side panel, a thread's Review tab and its way back,
// and Switch between review and main thread. BB's thread pages and chats need a real thread in the test BB, which needs a
// machine (a host daemon of its own): BB_E2E_THREAD names one. Plugin RPCs go to the official test host, as in
// review-flow; ThreadChat reads the real thread.
test.skipIf(!process.env.BB_E2E_URL || !process.env.BB_E2E_THREAD)("review ⇄ main thread: Main thread ↗ and back, Show beside review, Send then Watch, the thread's Review tab, and the switch key", async () => {
  const base = loopbackUrl("BB_E2E_URL", process.env.BB_E2E_URL!);
  const main = process.env.BB_E2E_THREAD!;
  vi.mocked(runGh).mockImplementation(async () => ({ code: 1, stderr: "no GitHub here", stdout: "" }));
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    get: async ({ threadId }: { threadId: string }) => ({ id: threadId, title: "Add b export", titleFallback: null, archivedAt: null, deletedAt: null, environmentId: null, status: "idle", visibility: "visible", originPluginId: null }),
    spawn: async () => ({ id: process.env.BB_E2E_AGENT_THREAD ?? "e2e-hidden-agent" }),
    send: async () => ({ ok: true, delivery: "sent" }),
    experimental_listAncestors: async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((threadId) => ({ threadId, ancestorIds: [] })) }),
    stop: async () => ({}), update: async () => ({}), archive: async () => ({}),
  }, projects: { defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }) } } as any });
  await plugin(bb);
  const store = queueStore(createStore(bb));
  // A long file, so the review has somewhere to scroll to and come back to.
  const lines = Array.from({ length: 160 }, (_, at) => `+export const n${at} = ${at};`).join("\n");
  const seed = async (key: string, title: string, file: string) => {
    await store.saveReview({ targetKey: key, kind: "ref", gitRef: `main...${key}`, title, status: "ready", createdAt: Date.now(), projectId: "test-project" });
    await store.saveGuide(key, { title, intent: `${title}.`, sections: [{ id: "c1", title: "Change", overview: "The change.", diffs: [{ file, description: "Edit" }] }], unplacedFiles: [] } as any);
    await store.savePatch(key, `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,160 @@\n${lines}\n`);
  };
  await seed("e2e-doing", "Add b export", "src/a.ts");
  await store.setLifecycle("e2e-doing", { sourceThreadId: main, sourceThreadAt: Date.now() });
  await store.upsertDraftComment("e2e-doing", { file: "src/a.ts", line: 1, side: "RIGHT", body: "Name it for what it counts." });
  await seed("e2e-other", "Retry uploads", "src/upload.ts");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dir = "docs/verification/native-panel";
  await mkdir(dir, { recursive: true });
  await page.route("**/api/v1/plugins/code-review-workspace/rpc/*", async (route) => {
    const method = new URL(route.request().url()).pathname.split("/").pop()!;
    const helpers: Record<string, unknown> = {
      getSetupStatus: { account: "reviewer", githubCli: true, agentAvailable: true, projectAvailable: true },
      getGhAccounts: { active: "reviewer", accounts: [{ login: "reviewer", active: true }] },
      getChecks: { bucket: "none", checks: [] },
      // The thread is the review's main thread.
      threadLinks: { reviewChangesLine: true, reviews: [{ targetKey: "e2e-doing", createdAt: 1, main, threads: [], folder: null }], agents: [] },
    };
    try {
      const result = helpers[method] ?? await harness.behavior.callRpc(method, route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, result } });
    } catch (error) { await route.fulfill({ status: 500, json: { ok: false, error: { message: String(error) } } }); }
  });
  const commands = page.getByRole("group", { name: "Review commands" });
  const review = `${base}/plugins/code-review-workspace/review/e2e-doing`;
  try {
    await page.goto(review);
    await hideBbPanel(page);
    await page.getByRole("button", { name: /^Start reading/ }).click();
    // Show beside review: BB's Main thread tab, the thread's own chat, with Main thread ↗.
    const beside = commands.getByRole("button", { name: "Show main thread beside review", exact: true });
    await beside.click();
    const tab = page.getByRole("region", { name: "Main thread", exact: true });
    await tab.getByRole("heading", { name: /^Main thread/ }).waitFor();
    await tab.getByRole("button", { name: "Main thread", exact: true }).waitFor();
    await expect.poll(() => beside.getAttribute("aria-pressed")).toBe("true");
    await page.waitForTimeout(1500);
    await page.screenshot({ animations: "disabled", path: `${dir}/main-tab-desktop.png` });
    // BB keeps a chat's unsent reply per thread: through its panel closing, and on the thread's own page (below).
    const reply = `Unsent reply ${Date.now()}`;
    const box = () => tab.locator("[contenteditable=true]").last();
    await box().click();
    await page.keyboard.type(reply);
    await hideBbPanel(page);
    await beside.click();
    await expect.poll(() => box().innerText()).toContain(reply);
    // Another review: no main thread, so no Main thread tab; the agent's is the review's own.
    await page.goto(`${base}/plugins/code-review-workspace/review/e2e-other`);
    const ask = commands.getByRole("button", { name: "Ask agent", exact: true });
    await ask.waitFor();
    await page.waitForTimeout(1000);
    await page.screenshot({ animations: "disabled", path: `${dir}/other-review-opened.png` });
    if (await ask.getAttribute("aria-pressed") !== "true") await ask.click();
    await page.getByRole("region", { name: "Review agent", exact: true }).getByText("local:e2e-other").waitFor();
    expect(await commands.getByRole("button", { name: "Go to main thread", exact: true }).count()).toBe(0);
    await page.screenshot({ animations: "disabled", path: `${dir}/agent-tab-other-review.png` });
    await hideBbPanel(page);
    // Send now, then Watch: the main thread beside the review, in one click.
    await page.goto(review);
    await hideBbPanel(page);
    const card = page.getByRole("article", { name: "Draft comment on src/a.ts:1" });
    await card.getByRole("button", { name: /^Send now to/ }).click();
    const watch = page.getByRole("button", { name: "Watch", exact: true });
    await watch.waitFor();
    await page.screenshot({ animations: "disabled", path: `${dir}/send-now-watch.png` });
    await watch.click();
    await expect.poll(() => beside.getAttribute("aria-pressed")).toBe("true");
    await page.waitForTimeout(800);
    await page.screenshot({ animations: "disabled", path: `${dir}/watch-main-tab.png` });
    await hideBbPanel(page);
    // Finish review: its key opens it, and the title bar's button, a local review's too, closes and opens it.
    const finish = commands.getByRole("button", { name: /^Finish review/ });
    await page.keyboard.press("s");
    await expect.poll(() => finish.getAttribute("aria-pressed"), { message: "s opens Finish review" }).toBe("true");
    await finish.click();
    await expect.poll(() => finish.getAttribute("aria-pressed"), { message: "Finish review closes it" }).toBe("false");
    await finish.click();
    // Its Change main thread: the Main thread tab opens with its menu, which stays open as BB focuses the chat box,
    // until a click outside it.
    await page.getByRole("complementary", { name: "Comments and Finish review", exact: true }).getByRole("button", { name: "Change main thread", exact: true }).click();
    const changeMenu = page.getByRole("menu", { name: "Change main thread", exact: true });
    await changeMenu.waitFor();
    await page.waitForTimeout(2000);
    expect(await changeMenu.isVisible(), "Change main thread's menu is still open 2 s after Finish review opened it").toBe(true);
    await page.screenshot({ animations: "disabled", path: `${dir}/change-main-thread-menu.png` });
    await tab.locator("[contenteditable=true]").last().click();
    await changeMenu.waitFor({ state: "hidden" });
    await finish.click();
    await hideBbPanel(page);
    await commands.getByRole("button", { name: "Ask agent", exact: true }).click();
    await page.getByRole("region", { name: "Review agent", exact: true }).waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ animations: "disabled", path: `${dir}/agent-tab-header.png` });
    await hideBbPanel(page);
    // Main thread ↗ goes to the thread: reviewing to doing, one click; the review keeps its place for the way back.
    const reading = page.getByRole("button", { name: /^(Start reading|Continue)/ });
    if (await reading.isVisible().catch(() => false)) await reading.click();
    const scroller = page.locator("[data-review-code]");
    await scroller.hover();
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(600);
    const before = await scroller.evaluate((el) => el.scrollTop);
    await commands.getByRole("button", { name: "Go to main thread", exact: true }).click();
    await page.waitForURL(new RegExp(main));
    await expect.poll(() => page.locator("[contenteditable=true]").evaluateAll((boxes) => boxes.map((el) => (el as HTMLElement).innerText).join("\n"))).toContain(reply);
    // Above its message box, the way back: the review it's the main thread of, with what's open, whatever its folder.
    const back = page.getByRole("button", { name: /^Review, / });
    await back.waitFor();
    await page.screenshot({ animations: "disabled", path: `${dir}/thread-line-back.png` });
    await back.click();
    await page.waitForURL(/\/review\/e2e-doing/);
    await page.waitForTimeout(1500);
    const after = await scroller.evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before), `the review's scroll, ${before} before the thread and ${after} after it, is where it was`).toBeLessThan(40);
    // And Main thread ↗ again, to its Review tab: the comment, Review ↗, and the agent's first message, there.
    await commands.getByRole("button", { name: "Go to main thread", exact: true }).click();
    await page.waitForURL(new RegExp(main));
    const show = page.getByRole("button", { name: /^Show right panel/ }).first();
    await show.waitFor({ timeout: 5000 }).then(() => show.click()).catch(() => {});
    await page.getByRole("button", { name: "Show review panel" }).click();
    const pane = page.getByRole("region", { name: "Review", exact: true });
    await pane.getByText("Name it for what it counts.").waitFor();
    await pane.getByRole("button", { name: "Go to review", exact: true }).waitFor();
    const first = pane.getByRole("textbox", { name: "Ask the agent" });
    await first.waitFor();
    await page.screenshot({ animations: "disabled", path: `${dir}/thread-review-tab.png` });
    if (process.env.BB_E2E_AGENT_THREAD) {
      await first.fill("Why name it so?");
      await pane.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => harness.inspection.sdk.callsTo("threads.spawn").length).toBe(1);
      await page.waitForTimeout(1500);
      expect(page.url()).toContain(main);
      await page.screenshot({ animations: "disabled", path: `${dir}/thread-review-tab-agent.png` });
    }
    // A comment's row opens the review at it.
    await pane.getByRole("button", { name: /src\/a\.ts:1/ }).click();
    await page.waitForURL(/\/review\/e2e-doing/);
    await page.getByRole("article", { name: "Draft comment on src/a.ts:1" }).waitFor();
    // The switch key: to the thread, and back.
    await page.locator("main[aria-label^='Review']").click({ position: { x: 200, y: 300 } });
    await page.keyboard.press("ControlOrMeta+Shift+Period");
    await page.waitForURL(new RegExp(main));
    await page.locator("body").click({ position: { x: 700, y: 400 } });
    await page.keyboard.press("ControlOrMeta+Shift+Period");
    await page.waitForURL(/\/review\/e2e-doing/);
    await commands.getByRole("button", { name: "Ask agent", exact: true }).waitFor();
    // A phone: BB's panel over the page, from the dock.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await hideBbPanel(page);
    await commands.getByRole("button", { name: "Ask agent", exact: true }).click();
    const agent = page.getByRole("region", { name: "Review agent", exact: true });
    await agent.waitFor();
    await page.waitForTimeout(800);
    expect(await agent.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: `${dir}/agent-phone.png` });
    await hideBbPanel(page);
    await page.screenshot({ animations: "disabled", path: `${dir}/dock-phone.png` });
    expect(errors).toEqual([]);
  } catch (error) { await page.screenshot({ path: `${dir}/failed.png` }); throw error; } finally { await browser.close(); await harness.lifecycle.dispose(); }
}, 120_000);
