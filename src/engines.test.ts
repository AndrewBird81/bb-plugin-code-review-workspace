import { expect, test } from "vitest";
import pkg from "../package.json";

const floor = (range: string) => range.replace(/^>=/, "").split(".").map(Number);
const atLeast = (version: number[], min: number[]) => version.reduce((order, part, i) => order || part - (min[i] ?? 0), 0) >= 0;

test("engines admit no host older than the SDK APIs the plugin calls", () => {
  // BB 0.48.0 is the host 1.8.0 was built and tested on: a folder's review reads its diff, files and status through
  // the Git plugin bb 0.48.0 bundles (its files, patches, fileSide and workspaceStatus calls; src/env-diff.ts,
  // src/push.ts). SDK 0.6.79 is what the 0.47.1 desktop app runs the panel with: it has every slot and hook the app
  // calls, and each experimental slot is registered with ?.(), so a client without one skips it.
  expect(atLeast(floor(pkg.engines.bbPluginSdk), [0, 6, 79])).toBe(true);
  expect(atLeast(floor(pkg.engines.bb), [0, 48, 0])).toBe(true);
  // The SDK the plugin is built and tested against is one the engines admit.
  expect(atLeast(floor(pkg.devDependencies["@get-bb/plugin-sdk"]), floor(pkg.engines.bbPluginSdk))).toBe(true);
});
