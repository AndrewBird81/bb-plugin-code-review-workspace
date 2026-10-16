// For tests, not the plugin: the backend tests' setup file. A `gh` that a test didn't mock would reach GitHub with
// the machine's account, so a stand-in `gh` goes first on PATH: it exits 99, and the test that ran it fails.
import { afterAll, afterEach } from "vitest";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const dir = join(tmpdir(), "guided-review-stand-in-gh");
// Each test process logs its own calls.
const log = process.env.GR_REAL_GH_LOG = join(dir, `calls-${process.pid}`);
mkdirSync(dir, { recursive: true });
// Written whole, then moved in, since other test processes may be running it.
const script = join(dir, `gh-${process.pid}`);
writeFileSync(script, `#!/bin/sh\necho "gh $*" >> "$GR_REAL_GH_LOG"\necho "A unit test ran the real gh: mock runGh from ./gh." >&2\nexit 99\n`);
chmodSync(script, 0o755);
renameSync(script, join(dir, "gh"));
writeFileSync(log, "");
if (process.env.PATH?.split(delimiter)[0] !== dir) process.env.PATH = [dir, process.env.PATH].join(delimiter);

/** The `gh` command lines tests ran since last asked, forgetting them. */
export function takeRealGhCalls(): string[] {
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  writeFileSync(log, "");
  return calls;
}

afterEach(() => {
  const calls = takeRealGhCalls();
  if (calls.length) throw new Error(`This test ran the real gh (${calls.join("; ")}). Mock runGh from ./gh.`);
});
afterAll(() => rmSync(log, { force: true }));
