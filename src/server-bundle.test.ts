import { expect, test } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type LockEntry = { dev?: boolean; optional?: boolean; devOptional?: boolean };

// BB installs a git plugin's packages with npm install --omit=dev --omit=optional, then bundles its server. A package the
// bundle takes from node_modules that the lockfile marks dev or optional isn't there, and the install or update fails:
// pg's require of pg-cloudflare, an optional dependency of pg, did in the 1.3.0 rehearsal.
test("the server's bundle takes from node_modules only packages BB installs, which omits dev and optional ones", async () => {
  const { metafile } = await build({
    entryPoints: [fileURLToPath(new URL("../server.ts", import.meta.url))],
    bundle: true, write: false, metafile: true, format: "esm", platform: "node", target: "node22", logLevel: "silent",
    // BB serves the SDK at load time.
    external: ["@get-bb/plugin-sdk", "@get-bb/plugin-sdk/*"],
  });
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as { packages: Record<string, LockEntry> };
  const packages = new Set(Object.keys(metafile.inputs).flatMap((file) => /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file)?.[1] ?? []));
  const omitted = [...packages].filter((path) => {
    const entry = lock.packages[path];
    return !entry || entry.dev || entry.optional || entry.devOptional;
  });
  expect(packages).toContain("node_modules/pg");
  expect(omitted).toEqual([]);
});
