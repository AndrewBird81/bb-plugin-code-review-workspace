// Setup's checks: the token's missing scopes, read from what GitHub says of it.
import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));

import plugin from "../server";

async function setupStatus(scopesHeader: string | null) {
  runGh.mockReset();
  runGh.mockImplementation(async (args: string[]) => {
    if (args[0] === "--version") return { code: 0, stderr: "", stdout: "gh version 2.80.0\n" };
    if (args.join(" ") === "api user --jq .login") return { code: 0, stderr: "", stdout: "me\n" };
    if (args.join(" ") === "api -i user") return { code: 0, stderr: "", stdout: ["HTTP/2.0 200 OK", ...(scopesHeader === null ? [] : [`X-Oauth-Scopes: ${scopesHeader}`]), "", "{\"login\":\"me\"}"].join("\r\n") };
    return { code: 0, stderr: "", stdout: "" };
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  harness.sdk.stub("providers.list", async () => []);
  harness.sdk.stub("projects.list", async () => []);
  await plugin(bb);
  return harness.behavior.callRpc("getSetupStatus", null);
}

test("setup status lists the scopes a classic token lacks, and says when a token doesn't list them", async () => {
  expect(await setupStatus("repo, gist")).toMatchObject({ account: "me", githubCli: true, missingScopes: ["read:org"] });
  expect(await setupStatus("repo, read:org")).toMatchObject({ missingScopes: [] });
  // A fine-grained token lists none.
  expect(await setupStatus(null)).toMatchObject({ account: "me", missingScopes: "unlisted" });
});
