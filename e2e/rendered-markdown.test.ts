import { expect, test, vi } from "vitest";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../src/store";
import plugin from "../server";
import { runGh } from "../src/gh";
import { loopbackUrl } from "./loopback";
import { queueStore } from "../src/store-queue";
import { gitPatch } from "../lib/markdown-test-patch.test-support";

vi.mock("../src/gh", async (original) => ({ ...await original<typeof import("../src/gh")>(), runGh: vi.fn() }));

const FILE = "docs/rfc-auth.md";
const OLD = `# Token lifetime RFC

We want short-lived tokens, so a stolen token is useless soon after it leaks.

## Goals

- Tokens expire quickly.
- Refresh tokens rotate.

## Lifetime

Tokens expire after 1 hour.

Refresh tokens are never rotated.

| Field | Type |
|-------|------|
| exp   | int  |

\`\`\`ts
export const LIFETIME = 3600;
\`\`\`

> Rotate the signing keys every year.

See [the threat model](threats.md) for why.
`;
const NEW = OLD.replace("1 hour", "15 minutes").replace("Refresh tokens are never rotated.\n\n", "")
  .replace("| exp   | int  |", "| exp   | int  |\n| iat   | int  |").replace("3600", "900")
  .replace("## Lifetime", "## Rotation\n\nEach refresh token works once.\n\n## Lifetime")
  .replace("- Refresh tokens rotate.", "- Refresh tokens rotate on every use.\n- Sessions end at logout.")
  .replace("## Goals", "## Goals and limits").replace("every year", "every month").replace("(threats.md)", "(security/threats.md)");

// The running BB supplies the real app shell, BB's own Markdown, and the built plugin; its RPCs go through the
// official test host, with GitHub mocked. A Markdown file shown rendered takes comments on its blocks, which submit at
// the lines GitHub takes.
test.skipIf(!process.env.BB_E2E_URL)("rendered Markdown: toggle, comment on a changed and a removed block, submit at their lines", async () => {
  const base = loopbackUrl("BB_E2E_URL", process.env.BB_E2E_URL!);
  vi.mocked(runGh).mockImplementation(async (args) => {
    if (args[0] === "auth") return { code: 0, stderr: "", stdout: "test-token" };
    if (args[1] === "user") return { code: 0, stderr: "", stdout: "reviewer" };
    if (args.includes("graphql")) return { code: 0, stderr: "", stdout: JSON.stringify({ data: { viewer: { login: "reviewer" }, repository: { pullRequest: { state: "OPEN", headRefOid: "sha1", reviews: { nodes: [] } } } } }) };
    if (args.includes("POST")) return { code: 0, stderr: "", stdout: '{"id":12}' };
    return { code: 0, stderr: "", stdout: JSON.stringify({ headRefOid: "sha1", state: "OPEN" }) };
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }),
    spawn: async () => ({ id: "e2e-hidden-agent" }), stop: async () => ({}), update: async () => ({}), archive: async () => ({}),
  } } });
  await plugin(bb);
  const store = queueStore(createStore(bb));
  const key = "e2e-markdown";
  await store.saveReview({ targetKey: key, kind: "pr", number: 8, repo: "acme/web", title: "Shorten token lifetime", author: "alice", status: "ready", createdAt: Date.now(), headSha: "sha1", projectId: "test-project" });
  await store.saveGuide(key, { title: "Shorten token lifetime", intent: "Tokens live 15 minutes.", sections: [{ id: "rfc", title: "The RFC", overview: "The RFC's new lifetime.", diffs: [{ file: FILE, description: "Lifetime and rotation" }] }], unplacedFiles: [] } as any);
  await store.savePatch(key, gitPatch(FILE, OLD, NEW));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dir = "docs/verification/rendered-markdown";
  await mkdir(dir, { recursive: true });
  await page.route("**/api/v1/plugins/code-review-workspace/rpc/*", async (route) => {
    const method = new URL(route.request().url()).pathname.split("/").pop()!;
    const helpers: Record<string, unknown> = {
      getSetupStatus: { account: "reviewer", githubCli: true, agentAvailable: true, projectAvailable: true },
      getGhAccounts: { active: "reviewer", accounts: [{ login: "reviewer", active: true }] },
      getChecks: { bucket: "none", checks: [] }, checkRepoAccess: { accessible: true, repo: "acme/web", account: "reviewer" },
      getFileContents: { ok: true, old: OLD, new: NEW },
    };
    try {
      const result = helpers[method] ?? await harness.behavior.callRpc(method, route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, result } });
    } catch (error) { await route.fulfill({ status: 500, json: { ok: false, error: { message: String(error) } } }); }
  });
  try {
    await page.goto(`${base}/plugins/code-review-workspace/review/${key}`);
    await page.getByRole("button", { name: /^Start reading: The RFC/ }).click();
    const file = page.locator(`[data-file="${FILE}"]`);
    await file.getByRole("radiogroup", { name: `How ${FILE} shows` }).getByRole("radio", { name: "Rendered" }).click();
    const rendered = file.locator("[data-md-rendered]");
    await rendered.waitFor();
    // BB's Markdown drew each block: the table, and the code with its highlighting.
    await rendered.locator("table").waitFor();
    expect(await rendered.locator("[data-md-status]").evaluateAll((units) => units.map((unit) => (unit as HTMLElement).dataset.mdStatus)))
      .toEqual(["unchanged", "unchanged", "changed", "unchanged", "changed", "added", "added", "added", "unchanged", "changed", "removed", "changed", "changed", "changed", "changed"]);
    // BB's Markdown draws the changed words marked, in a heading, a list item, a paragraph and a quote; the table's and
    // the code's changes cross their syntax, so they show whole.
    const changedBlock = (n: number) => rendered.locator('[data-md-status="changed"]').nth(n);
    const paragraph = changedBlock(2);
    await paragraph.locator("del").waitFor();
    const marks = async (n: number) => [await changedBlock(n).locator("del").allTextContents(), await changedBlock(n).locator("ins").allTextContents()];
    expect(await marks(0)).toEqual([[], ["and limits"]]);
    expect(await marks(1)).toEqual([[], ["on every use"]]);
    expect(await marks(2)).toEqual([["1 hour"], ["15 minutes"]]);
    expect(await marks(3)).toEqual([[], []]);
    expect(await marks(4)).toEqual([[], []]);
    expect(await marks(5)).toEqual([["year"], ["month"]]);
    // The link whose URL changed is said under its block.
    expect(await changedBlock(6).getByRole("note", { name: "Link changed" }).textContent()).toBe("Link changed: the threat modelthreats.md to security/threats.md");
    // The table tints its new row, from a style of its own, and each row takes a comment: the new row's here.
    const table = changedBlock(3);
    expect(await table.locator("tbody tr").nth(1).evaluate((row) => getComputedStyle(row).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await table.locator("tbody tr").nth(1).hover();
    await table.getByRole("button", { name: "Comment on table row 2 (line 22)" }).click();
    await page.getByRole("textbox", { name: "Draft comment", exact: true }).fill("Is iat needed?");
    await page.getByRole("button", { name: "Add to draft", exact: true }).click();
    await table.getByRole("article").waitFor();
    // Text selected in the code picks its line: the fence's next.
    await changedBlock(4).evaluate((block) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf("LIFETIME");
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + "LIFETIME".length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        return;
      }
    });
    await page.getByRole("group", { name: "Selection" }).getByText("L25", { exact: true }).waitFor();
    await page.getByRole("group", { name: "Selection" }).getByRole("button", { name: "Clear selection" }).click();
    await page.evaluate(() => getSelection()!.removeAllRanges());
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(500);
      await file.screenshot({ animations: "disabled", path: `${dir}/rendered-${scheme}.png` });
    }
    // + on the changed paragraph, then on the removed one: their lines, new and old.
    const changed = paragraph;
    await changed.hover();
    await changed.getByRole("button", { name: /^Comment on line/ }).click();
    await page.getByRole("textbox", { name: "Draft comment", exact: true }).fill("Is 15 minutes enough for mobile?");
    await page.getByRole("button", { name: "Add to draft", exact: true }).click();
    await changed.getByRole("article", { name: /^Draft comment on docs\/rfc-auth\.md:/ }).waitFor();
    const removed = rendered.locator('[data-md-status="removed"]');
    await removed.hover();
    await removed.getByRole("button", { name: /^Comment on line .* \(old\)$/ }).click();
    await page.getByRole("textbox", { name: "Draft comment", exact: true }).fill("Why drop this? Mobile clients rely on it.");
    await page.getByRole("button", { name: "Add to draft", exact: true }).click();
    await removed.getByRole("article").waitFor();
    await file.screenshot({ animations: "disabled", path: `${dir}/rendered-comments-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(500);
    await file.screenshot({ animations: "disabled", path: `${dir}/rendered-comments-dark.png` });
    // The table's version before, above it, and a block's + in the gutter.
    await changedBlock(3).getByRole("button", { name: "Show previous", exact: true }).click();
    await changedBlock(3).hover();
    await file.screenshot({ animations: "disabled", path: `${dir}/rendered-previous-dark.png` });
    const comments = (await store.getDraft(key)).comments.map(({ line, side, startLine }) => ({ line, side, startLine }));
    expect(comments).toEqual(expect.arrayContaining([{ line: 17, side: "RIGHT", startLine: undefined }, { line: 14, side: "LEFT", startLine: undefined }]));
    // Submitted, they go to GitHub at those lines.
    const commands = page.getByRole("group", { name: "Review commands" });
    await commands.getByRole("button", { name: /^Finish review:/ }).click();
    await page.getByRole("group", { name: "Review verdict" }).getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByRole("button", { name: /^Submit to GitHub/ }).click();
    await page.getByRole("region", { name: "Submitted review" }).waitFor();
    const submission = vi.mocked(runGh).mock.calls.find(([args]) => args.includes("POST"));
    const payload = JSON.parse(submission![1]!.stdin!);
    expect(payload.comments.map(({ path, line, side }: any) => ({ path, line, side }))).toEqual(expect.arrayContaining([{ path: FILE, line: 17, side: "RIGHT" }, { path: FILE, line: 14, side: "LEFT" }]));
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 120_000);
