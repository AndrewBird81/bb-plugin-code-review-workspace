import { expect, test } from "vitest";
import { chromium } from "playwright";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdir } from "node:fs/promises";
import { createStore } from "../src/store";
import { generateGuide } from "../src/generate";
import plugin from "../server";
import { queueStore } from "../src/store-queue";

// Only run against a dedicated BB with both test builds installed. Guide work
// and all review/GitHub RPCs are simulated; Needs You storage/realtime/UI is real.
test.skipIf(!process.env.BB_ACTIVITY_E2E_URL)("guide completion → Needs You popup → review → retained inbox → dismiss", async () => {
  const base = process.env.BB_ACTIVITY_E2E_URL!;
  if (!/^http:\/\/127\.0\.0\.1:4333$/.test(base)) throw new Error("Use the isolated activity test BB on port 4333");
  const rpc = async (method: string, input: any) => {
    const response = await fetch(`${base}/api/v1/plugins/inbox/rpc/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const payload = await response.json();
    if (!payload.ok) throw new Error(JSON.stringify(payload));
    return payload.result;
  };
  await rpc("setupFinish", null);
  const key = `notification-e2e-${Date.now()}`;
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    plugins: { callRpc: ({ method, input }: any) => rpc(method, input) },
    threads: { spawn: async () => ({ id: "synthetic-hidden-worker" }), archive: async () => {}, stop: async () => {} },
  } });
  await plugin(bb);
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: key, kind: "ref", gitRef: "feature", title: "Notification integration check", status: "generating", createdAt: Date.now(), projectId: "test-project" });
  await store.savePatch(key, 'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old();\n+newCall();\n');
  harness.inspection.sdk.stub("threads.wait", async () => {
    await store.saveGuide(key, { title: "Notification integration check", intent: "Read the completed guide.", sections: [{ id: "entry", title: "Entry point", overview: "Update the call.", diffs: [{ file: "example.ts", summary: "New call" }] }], unplacedFiles: [] });
    return { matched: true };
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/v1/plugins/code-review-workspace/rpc/*", async route => {
    const method = new URL(route.request().url()).pathname.split("/").pop()!;
    try { await route.fulfill({ json: { ok: true, result: await harness.behavior.callRpc(method, route.request().postDataJSON()) } }); }
    catch (e) { await route.fulfill({ status: 500, json: { ok: false, error: { message: String(e) } } }); }
  });
  try {
    await page.goto(`${base}/plugins/inbox/inbox`);
    await page.getByRole("heading", { name: "Needs You", exact: true }).waitFor();
    await generateGuide(bb, store, key, "test-project");
    const open = page.getByRole("button", { name: "Open review", exact: true });
    await open.waitFor();
    expect(await page.locator("[data-sonner-toast]").filter({ hasText: "Notification integration check" }).count()).toBe(1);
    await mkdir("docs/verification", { recursive: true });
    await page.waitForTimeout(350); // Let the native toast entrance settle for the artifact.
    await page.screenshot({ path: "docs/verification/needs-you-guide-ready.png" });
    await open.click();
    await page.waitForURL(`${base}/plugins/code-review-workspace/review/${key}`);
    await page.getByText("Read the completed guide.", { exact: true }).waitFor();
    await generateGuide(bb, store, key, "test-project");
    // A server RPC barrier plus an event-loop round trip lets realtime arrive.
    await rpc("list", {});
    await page.waitForTimeout(600);
    expect(await page.getByRole("button", { name: "Open review", exact: true }).count()).toBe(0);
    await page.goto(`${base}/plugins/inbox/inbox`);
    const row = page.getByRole("button", { name: "Open Notification integration check", exact: true });
    await row.waitFor();
    expect(await row.count()).toBe(1);
    await page.reload();
    await row.waitFor();
    await page.getByRole("button", { name: "Dismiss Notification integration check", exact: true }).click();
    await row.waitFor({ state: "hidden" });
    const list = await rpc("list", {});
    expect(list.items.some((item: any) => item.id?.endsWith(key))).toBe(false);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await harness.lifecycle.dispose(); }
}, 60_000);
