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
