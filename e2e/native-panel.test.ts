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
test.skipIf(!process.env.BB_E2E_URL || !process.env.BB_E2E_THREAD)("review ⇄ main thread: Main thread ↗, Show beside review, the thread's Review tab, Ask the review agent, and the switch key", async () => {
  const base = loopbackUrl("BB_E2E_URL", process.env.BB_E2E_URL!);
  const main = process.env.BB_E2E_THREAD!;
  vi.mocked(runGh).mockImplementation(async () => ({ code: 1, stderr: "no GitHub here", stdout: "" }));
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    get: async ({ threadId }: { threadId: string }) => ({ id: threadId, title: "Add b export", titleFallback: null, archivedAt: null, deletedAt: null, environmentId: null, status: "idle", visibility: "visible", originPluginId: null }),
    spawn: async () => ({ id: "e2e-hidden-agent" }),
    stop: async () => ({}), update: async () => ({}), archive: async () => ({}),
  }, projects: { defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }) } } as any });
  await plugin(bb);
  const store = queueStore(createStore(bb));
  const seed = async (key: string, title: string, file: string) => {
    await store.saveReview({ targetKey: key, kind: "ref", gitRef: `main...${key}`, title, status: "ready", createdAt: Date.now(), projectId: "test-project" });
    await store.saveGuide(key, { title, intent: `${title}.`, sections: [{ id: "c1", title: "Change", overview: "The change.", diffs: [{ file, description: "Edit" }] }], unplacedFiles: [] } as any);
    await store.savePatch(key, `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,2 @@\n+export const b = 2;\n+export const c = 3;\n`);
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
    // Show beside review: BB's Main thread tab, the thread's own chat, with Go to thread.
    const beside = commands.getByRole("button", { name: "Show main thread beside review", exact: true });
    await beside.click();
    const tab = page.getByRole("region", { name: "Main thread", exact: true });
    await tab.getByRole("heading", { name: /^Main thread/ }).waitFor();
    await tab.getByRole("button", { name: "Go to thread" }).waitFor();
    expect(await beside.getAttribute("aria-pressed")).toBe("true");
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
    // Main thread ↗ goes to the thread: reviewing to doing, one click.
    await page.goto(review);
    await commands.getByRole("button", { name: "Go to main thread", exact: true }).click();
    await page.waitForURL(new RegExp(main));
    await expect.poll(() => page.locator("[contenteditable=true]").evaluateAll((boxes) => boxes.map((el) => (el as HTMLElement).innerText).join("\n"))).toContain(reply);
    // Its Review tab: the review, its comment, Review ↗, and Ask the review agent.
    const show = page.getByRole("button", { name: /^Show right panel/ }).first();
    await show.waitFor({ timeout: 5000 }).then(() => show.click()).catch(() => {});
    await page.getByRole("button", { name: "Show review panel" }).click();
    const pane = page.getByRole("region", { name: "Review", exact: true });
    await pane.getByText("Name it for what it counts.").waitFor();
    await pane.getByRole("button", { name: "Go to review", exact: true }).waitFor();
    await page.screenshot({ animations: "disabled", path: `${dir}/thread-review-tab.png` });
    // The switch key goes back to the review, and from there to the thread again.
    await page.locator("body").click({ position: { x: 700, y: 400 } });
    await page.keyboard.press("ControlOrMeta+Shift+Period");
    await page.waitForURL(/\/review\/e2e-doing/);
    await commands.getByRole("button", { name: "Ask agent", exact: true }).waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+Period");
    await page.waitForURL(new RegExp(main));
    // Ask the review agent: the review opens with BB's Review agent tab.
    await page.getByRole("button", { name: "Show review panel" }).click().catch(() => {});
    await pane.getByRole("button", { name: "Ask the review agent" }).click();
    await page.waitForURL(/\/review\/e2e-doing/);
    await page.getByRole("region", { name: "Review agent", exact: true }).getByRole("textbox", { name: "Ask the agent" }).waitFor();
    await page.screenshot({ animations: "disabled", path: `${dir}/agent-from-thread.png` });
    // A phone: BB's panel over the page, from the dock.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await hideBbPanel(page);
    await commands.getByRole("button", { name: "Ask agent", exact: true }).click();
    const agent = page.getByRole("region", { name: "Review agent", exact: true });
    await agent.getByRole("textbox", { name: "Ask the agent" }).waitFor();
    expect(await agent.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: `${dir}/agent-phone.png` });
    await hideBbPanel(page);
    await page.screenshot({ animations: "disabled", path: `${dir}/dock-phone.png` });
    expect(errors).toEqual([]);
  } catch (error) { await page.screenshot({ path: `${dir}/failed.png` }); throw error; } finally { await browser.close(); await harness.lifecycle.dispose(); }
}, 120_000);
