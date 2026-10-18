import { expect, test } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// bug bash verification 73: the diff's cards took unplacedSummary from src/guide, whose schemas import zod, and the page's
// bundle grew by zod's whole runtime. Only the server validates with zod.
test("the page's code reaches no zod, as only the server's schemas use it", async () => {
  const { metafile } = await build({
    entryPoints: [fileURLToPath(new URL("../app.tsx", import.meta.url))],
    bundle: true, write: false, metafile: true, format: "esm", platform: "browser", jsx: "automatic", logLevel: "silent",
    // Packages and styles are left out: the test asks only which of them the page's own files import.
    plugins: [{ name: "packages", setup: (bundler) => bundler.onResolve({ filter: /^[^./]|\.css$/ }, ({ path }) => ({ path, external: true })) }],
  });
  const importers = Object.entries(metafile.inputs).filter(([, input]) => input.imports.some(({ path }) => path === "zod" || path.startsWith("zod/"))).map(([file]) => file);
  expect(Object.keys(metafile.inputs)).toContain("components/DiffViewer.tsx");
  expect(importers).toEqual([]);
});
