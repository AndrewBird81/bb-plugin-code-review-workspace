import { afterEach, expect, test } from "vitest";
import { cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
afterEach(cleanup);

async function readiness(missingScopes: string[] | "unlisted" | null | undefined) {
  await loadPluginApp(() => import("../app"));
  const { SetupReadiness } = await import("./ReleaseSettings");
  return renderSlot({ component: () => <SetupReadiness /> }, {}, { rpc: {
    getSetupStatus: () => ({ account: "casey", githubCli: true, agentAvailable: true, projectAvailable: true, ...(missingScopes !== undefined ? { missingScopes } : {}) }),
  } });
}

test("Setup names the scopes the GitHub token lacks and the command that adds them", async () => {
  const slot = await readiness(["repo", "read:org"]);
  const row = (await slot.findByText(/Your GitHub token is missing/)).closest("li")!;
  expect(row.textContent).toBe("Your GitHub token is missing repo and read:org. Posting needs repo, and team reviewers need read:org. On the BB server, run gh auth refresh -h github.com -s repo,read:org");
});

test("Setup tells a token that doesn't list its scopes from a check that failed, and says nothing when none are missing", async () => {
  const unlisted = await readiness("unlisted");
  const row = (await unlisted.findByText(/doesn’t list its scopes/)).closest("li")!;
  expect(row.textContent).toBe("Your GitHub token doesn’t list its scopes, as fine-grained tokens don’t, so they weren’t checked. If posting fails, check the token’s access to the repo.");
  expect(row.textContent).not.toContain("read:org");
  cleanup();
  expect(await (await readiness(null)).findByText("Couldn’t check your GitHub token’s scopes. Check setup again.")).toBeTruthy();
  cleanup();
  for (const scopes of [[], undefined]) {
    const fine = await readiness(scopes);
    await fine.findByText("@casey");
    expect(fine.queryByText(/token/)).toBeNull();
    cleanup();
  }
});
