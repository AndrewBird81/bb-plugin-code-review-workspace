import { expect, test } from "vitest";
import { digestText, lockfileDigest, packagesChange } from "./lockfile-digest";

const diff = (lines: string[]) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,${lines.length} +1,${lines.length} @@\n${lines.join("\n")}\n`;

test("package-lock.json: packages added and removed by key, and an added entry's host that isn't the registry's", () => {
  const digest = lockfileDigest("web/package-lock.json", diff([
    '     "node_modules/left-pad": {',
    '-    "node_modules/is-odd": {',
    '-      "resolved": "https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz",',
    '+    "node_modules/@acme/util": {',
    '+      "resolved": "https://registry.npmjs.org/@acme/util/-/util-1.0.0.tgz",',
    '+    "node_modules/@acme/util/node_modules/tiny": {',
    '+      "resolved": "https://evil.example.com/tiny-1.0.0.tgz",',
    '+    "node_modules/lodash": {',
    '+      "resolved": "git+ssh://git@github.com/lodash/lodash.git#abc",',
  ]));
  expect(digest).toEqual({ added: 3, removed: 1, hosts: ["evil.example.com", "github.com"] });
  expect(packagesChange(digest!)).toBe("+3 −1 packages");
  expect(digestText(digest!)).toBe("+3 −1 packages, downloads from evil.example.com, github.com");
});

test("yarn.lock: entries by name, a range bump nets zero, and a host already in the lockfile isn't flagged", () => {
  const digest = lockfileDigest("yarn.lock", diff([
    '-lodash@^4.17.20:',
    '+lodash@^4.17.21:',
    '+"@babel/core@^7.0.0", "@babel/core@^7.1.0":',
    '+  version "7.1.0"',
    '+  resolved "https://npm.acme.internal/@babel/core/-/core-7.1.0.tgz#abc"',
    '   resolved "https://npm.acme.internal/left-pad/-/left-pad-1.3.0.tgz#def"',
    '+left-pad@^1.3.0:',
    '+  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#def"',
  ]));
  expect(digest).toEqual({ added: 2, removed: 0, hosts: [] });
});

test("pnpm-lock.yaml: package keys of each version's form, and tarball hosts", () => {
  const digest = lockfileDigest("pnpm-lock.yaml", diff([
    "+  /left-pad@1.3.0:",
    "+  '@acme/util@1.0.0':",
    "+    resolution: {integrity: sha512-x, tarball: https://evil.example.com/util-1.0.0.tgz}",
    "+  react-dom@18.2.0(react@18.2.0):",
    "-  /is-odd/3.0.1:",
    "+  /@babel/core/7.1.0:",
    "   .:",
    "+  lockfileVersion: '9.0'",
  ]));
  expect(digest).toEqual({ added: 4, removed: 1, hosts: ["evil.example.com"] });
});

test("Cargo.lock, poetry.lock and go.sum count packages by name; another file, or one that changes none, has no digest", () => {
  expect(lockfileDigest("Cargo.lock", diff(['+name = "serde"', '+version = "1.0.0"', '-name = "time"', ' name = "rand"']))).toEqual({ added: 1, removed: 1, hosts: [] });
  expect(lockfileDigest("poetry.lock", diff(['+name = "requests"']))).toEqual({ added: 1, removed: 0, hosts: [] });
  expect(lockfileDigest("go.sum", diff(["-golang.org/x/net v0.1.0 h1:abc=", "-golang.org/x/net v0.1.0/go.mod h1:def=", "+golang.org/x/net v0.2.0 h1:ghi=", "+golang.org/x/net v0.2.0/go.mod h1:jkl=", "+github.com/acme/x v1.0.0 h1:mno="]))).toEqual({ added: 1, removed: 0, hosts: [] });
  expect(lockfileDigest("src/package.json", diff(['+    "node_modules/x": {']))).toBeNull();
  expect(lockfileDigest("package-lock.json", diff(['-      "version": "1.0.0",', '+      "version": "1.0.1",']))).toBeNull();
});

// Only npm's, yarn's and pnpm's entries named their hosts, so a swapped source in another format's stub went unseen
// (SUMMARY LH).
const composerPackage = (source: string, dist: string) => [
  "+        {",
  '+            "name": "acme/tool",',
  '+            "version": "v1.2.0",',
  '+            "source": {',
  '+                "type": "git",',
  `+                "url": "${source}",`,
  '+                "reference": "abc"',
  "+            },",
  '+            "dist": {',
  '+                "type": "zip",',
  `+                "url": "${dist}",`,
  '+                "reference": "abc",',
  '+                "shasum": ""',
  "+            },",
  '+            "require": {',
  '+                "php": ">=8.1"',
  "+            },",
  '+            "type": "library",',
  '+            "notification-url": "https://packagist.org/downloads/",',
  '+            "authors": [',
  "+                {",
  '+                    "name": "Ann",',
  '+                    "email": "ann@acme.dev",',
  '+                    "homepage": "https://acme.dev"',
  "+                }",
  "+            ],",
  '+            "homepage": "https://acme.dev/tool",',
  '+            "support": {',
  '+                "issues": "https://github.com/acme/tool/issues",',
  '+                "source": "https://github.com/acme/tool/tree/v1.2.0"',
  "+            },",
  '+            "funding": [',
  "+                {",
  '+                    "url": "https://tidelift.com/funding/github/packagist/acme/tool",',
  '+                    "type": "tidelift"',
  "+                }",
  "+            ],",
  '+            "time": "2026-01-01T00:00:00+00:00"',
  "+        },",
];

test("composer.lock: a package's source and dist hosts that aren't GitHub's or Packagist's, and not its homepage, support or funding", () => {
  expect(lockfileDigest("composer.lock", diff(composerPackage("https://github.com/acme/tool.git", "https://api.github.com/repos/acme/tool/zipball/abc")))).toBeNull();
  expect(lockfileDigest("composer.lock", diff(composerPackage("https://github.com/acme/tool.git", "https://evil.test/tool.zip")))).toEqual({ added: 0, removed: 0, hosts: ["evil.test"] });
  expect(lockfileDigest("composer.lock", diff(composerPackage("git@git.evil.test:acme/tool.git", "https://api.github.com/repos/acme/tool/zipball/abc")))).toEqual({ added: 0, removed: 0, hosts: ["git.evil.test"] });
  // A hunk that begins inside an object still names the URL it can't place.
  expect(lockfileDigest("composer.lock", diff(['+                "url": "https://evil.test/tool.zip",']))?.hosts).toEqual(["evil.test"]);
});

test("Gemfile.lock, uv.lock, Package.resolved, Cargo.lock and bun.lock name an added URL's host that isn't their registry's or already there", () => {
  expect(lockfileDigest("Gemfile.lock", diff([" GEM", "-  remote: https://rubygems.org/", "+  remote: https://evil.test/", "   specs:"]))?.hosts).toEqual(["evil.test"]);
  expect(lockfileDigest("Gemfile.lock", diff([" GEM", "   remote: https://rubygems.org/", "+    rack (3.0.0)"]))).toBeNull();
  expect(lockfileDigest("uv.lock", diff([
    "+[[package]]",
    '+name = "requests"',
    '+source = { registry = "https://pypi.org/simple" }',
    '+sdist = { url = "https://files.pythonhosted.org/packages/ab/requests-2.32.0.tar.gz", hash = "sha256:x" }',
  ]))).toBeNull();
  expect(lockfileDigest("ios/App.xcworkspace/xcshareddata/swiftpm/Package.resolved", diff([
    '       "identity" : "alamofire",',
    '       "kind" : "remoteSourceControl",',
    '-      "location" : "https://github.com/Alamofire/Alamofire.git",',
    '+      "location" : "https://git.evil.test/Alamofire/Alamofire.git",',
  ]))?.hosts).toEqual(["git.evil.test"]);
  expect(lockfileDigest("Package.resolved", diff(['-        "repositoryURL": "https:\\/\\/github.com\\/a\\/b",', '+        "repositoryURL": "git@evil.test:a/b.git",']))?.hosts).toEqual(["evil.test"]);
  // A new pin on GitHub, as most Swift packages are, isn't a new host (70-review-correctness #4).
  expect(lockfileDigest("Package.resolved", diff([
    '+      "identity" : "swift-log",',
    '+      "kind" : "remoteSourceControl",',
    '+      "location" : "https://github.com/apple/swift-log.git",',
  ]))).toBeNull();
  expect(lockfileDigest("Cargo.lock", diff([
    '+name = "serde"',
    '+source = "registry+https://github.com/rust-lang/crates.io-index"',
    '+name = "rand"',
    '+source = "sparse+https://index.crates.io/"',
    '+name = "tool"',
    '+source = "git+https://github.com/acme/tool?rev=abc#abc"',
  ]))).toEqual({ added: 3, removed: 0, hosts: ["github.com"] });
  expect(lockfileDigest("bun.lock", diff(['+    "tiny": ["tiny@1.0.0", "https://npm.evil.test/tiny/-/tiny-1.0.0.tgz", {}, "sha512-x"],', '+    "pad": ["pad@1.0.0", "", {}, "sha512-y"],']))?.hosts).toEqual(["npm.evil.test"]);
});

// Each word boundary in a long run of a scheme's characters began a scan to the run's end, so one long row in any
// lockfile but npm's, yarn's and pnpm's blocked the server for seconds (71-review-security F2).
test("a long row of a scheme's characters digests at once, and a URL after one still counts", () => {
  for (const [path, row] of [["flake.lock", `+${"a.".repeat(100_000)}`], ["Gemfile.lock", `+${"a+".repeat(100_000)}`], ["composer.lock", `+    "url": "${"a-".repeat(100_000)}",`]]) {
    const start = performance.now();
    expect(lockfileDigest(path, diff([row]))).toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
  }
  expect(lockfileDigest("flake.lock", diff([`+  "url": "git+https://evil.test/a.git", ${"a.".repeat(50)} https://b.evil.test/c`]))?.hosts).toEqual(["evil.test", "b.evil.test"]);
});
