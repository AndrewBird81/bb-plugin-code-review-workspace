// For tests, not the plugin: a backend tests' setup file. A guide writer's run reads what it asked as it started
// (threads.interactions.list), and fails when it can't; a fake host lists nothing pending, as BB does for a thread that
// asked nothing, unless the test passes its own.
import { vi } from "vitest";

vi.mock("@get-bb/plugin-sdk/testing", async (original) => {
  const actual = await original<typeof import("@get-bb/plugin-sdk/testing")>();
  const createFakePluginHost: typeof actual.createFakePluginHost = (...args) => {
    const host = actual.createFakePluginHost(...args);
    const options = args[0] as { sdk?: { threads?: { interactions?: { list?: unknown } } } } | undefined;
    if (!options?.sdk?.threads?.interactions?.list) host.harness.sdk.stub("threads.interactions.list", async () => []);
    return host;
  };
  return { ...actual, createFakePluginHost };
});
