import { test, expect } from "vitest";
import { classifyFile, declaredGenerated } from "./classify";

test("tests get a neutral tag and stay in review", () => {
  for (const p of [
    "src/foo.test.ts",
    "src/foo.spec.tsx",
    "components/__tests__/Bar.tsx",
    "pkg/server_test.go",
    "app/test_models.py",
    "app/models_test.py",
    "tests/integration/run.py",
    "src/test/java/FooTest.java",
    "spec/models/user_spec.rb",
  ]) {
    const c = classifyFile(p);
    expect(c.category, p).toBe("test");
    expect(c.skippable, p).toBe(false);
  }
});

test("lockfiles are skippable", () => {
  for (const p of [
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock",
    "bun.lock", "bun.lockb", "uv.lock", "poetry.lock", "Pipfile.lock", "flake.lock",
    "ios/Package.resolved", "composer.lock", "Gemfile.lock", "go.sum",
  ]) {
    const c = classifyFile(p);
    expect(c.category, p).toBe("lockfile");
    expect(c.skippable, p).toBe(true);
  }
});

test("generated/build output is skippable", () => {
  for (const p of ["dist/app.js", "build/index.html", "app.min.js", "src/api.generated.ts", "dist/index.d.ts", "src/generated/api.d.ts", "src/__snapshots__/x.snap", "x.test.js.snap", "src/__snapshots__/x.test.ts.snap"]) {
    const c = classifyFile(p);
    expect(c.category, p).toBe("generated");
    expect(c.skippable, p).toBe(true);
  }
});

test("hand-written declarations are code", () => {
  expect(classifyFile("src/env.d.ts").category).toBe("code");
});

test("docs and config are recognized but not skippable", () => {
  expect(classifyFile("README.md").category).toBe("docs");
  expect(classifyFile("docs/guide.md").category).toBe("docs");
  expect(classifyFile("tsconfig.json").category).toBe("config");
  expect(classifyFile(".eslintrc.yml").category).toBe("config");
  expect(classifyFile("README.md").skippable).toBe(false);
});

test("ordinary source is code and not skippable", () => {
  const c = classifyFile("src/server.ts");
  expect(c.category).toBe("code");
  expect(c.skippable).toBe(false);
  expect(classifyFile("src/latest.py").category).toBe("code");
  expect(classifyFile("src/testing.ts").category).toBe("code");
});

test("a test file that also looks like code resolves as test (test wins)", () => {
  expect(classifyFile("src/deep/module.test.ts").category).toBe("test");
});

test("every result carries a short human label", () => {
  expect(classifyFile("a.test.ts").label).toBe("test");
  expect(classifyFile("yarn.lock").label).toBe("lockfile");
  expect(classifyFile("dist/x.js").label).toBe("generated");
});

test("files the repo's .gitattributes marks linguist-generated or linguist-vendored are generated", () => {
  const attributes = [
    "# Generated code",
    "*.pb.go linguist-generated=true",
    "/api/schema.ts linguist-generated",
    "vendor/** linguist-vendored",
    "vendor/keep/** -linguist-vendored",
    "docs/**/*.html linguist-generated",
    "build/ linguist-generated",
    "*.md text eol=lf",
  ].join("\n");
  expect(declaredGenerated(attributes, [
    "svc/user.pb.go", "api/schema.ts", "web/api/schema.ts", "vendor/lib/x.js", "vendor/keep/y.js",
    "docs/a/b/page.html", "docs/page.html", "build/out.js", "README.md", "src/main.go",
  ])).toEqual(["svc/user.pb.go", "api/schema.ts", "vendor/lib/x.js", "docs/a/b/page.html", "docs/page.html"]);
  expect(declaredGenerated("", ["a.ts"])).toEqual([]);
});

test("a .gitattributes pattern can't stall the server or break the list", () => {
  const start = performance.now();
  expect(declaredGenerated(`${"*a".repeat(16)}*b linguist-generated`, ["a".repeat(60)])).toEqual([]);
  expect(performance.now() - start).toBeLessThan(100);
  expect(declaredGenerated("[z-a].ts linguist-generated\n*.pb.go linguist-generated", ["x.ts", "a.pb.go"])).toEqual(["a.pb.go"]);
});
