import { expect, test } from "vitest";
import pkg from "../package.json";

const floor = (range: string) => range.replace(/^>=/, "").split(".").map(Number);
const atLeast = (version: number[], min: number[]) => version.reduce((order, part, i) => order || part - (min[i] ?? 0), 0) >= 0;

test("engines admit no host older than the SDK APIs the plugin calls", () => {
  // SDK 0.6.14 is the first whose spawn and ProviderModelPicker take a provider's serviceTier string, which
  // spawnExecution and the agent pickers pass; 0.6.9's types reject it. BB 0.45.0 is the first release with it (0.6.15).
  expect(atLeast(floor(pkg.engines.bbPluginSdk), [0, 6, 14])).toBe(true);
  expect(atLeast(floor(pkg.engines.bb), [0, 45, 0])).toBe(true);
  // The SDK the plugin is built and tested against is one the engines admit.
  expect(atLeast(floor(pkg.devDependencies["@get-bb/plugin-sdk"]), floor(pkg.engines.bbPluginSdk))).toBe(true);
});
