// Every message the plugin sends a review agent is marked with who it's from (src/asking.ts), so a turn it starts never
// reads as yours. A send or spawn that skipped the mark would read as typed in the review; this keeps each one going
// through sendToAgent or spawnAgent, and each check the plugin starts saying it started it (PC1, PC2).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const root = join(__dirname, "..");
const code = (dir: string) => readdirSync(join(root, dir), { recursive: true }).map(String)
  .filter((file) => /\.tsx?$/.test(file) && !/\.test(-support)?\.tsx?$/.test(file)).map((file) => join(dir, file));
const sources = ["server.ts", "app.tsx", ...code("src"), ...code("lib"), ...code("components"), ...code("hooks")];
const read = (file: string) => readFileSync(join(root, file), "utf8");

/**
 * What starts a thread's turn, however it's reached: a send, spawn, fork or retry, with `?.`, by its name in brackets, or
 * past a cast; a queued message made or changed; and `bb.sdk.threads` (or `bb.sdk`) taken under another name or handed
 * to a function, which hides the rest.
 */
const STARTS_TURNS = [
  /\bthreads\??\.(send|spawn|fork|retry)\b/g,
  /\bthreads\b[^;\n]{0,40}\)\s*\??\.\s*(send|spawn|fork|retry)\b/g,
  /[(,]\s*bb\??\.sdk\??\.threads\s*[,)]/g,
  /\bthreads\s*\??\.?\s*\[/g,
  /\bqueuedMessages\??\.(create|send|update|reorder)\b|\bqueuedMessages\s*\??\.?\s*\[/g,
  /=\s*bb\??\.sdk\??\.threads\s*[;,)]|\{[^}]*\bthreads\b[^}]*\}\s*=\s*bb\??\.sdk\b|\bsdk\s*\??\.?\s*\[|=\s*bb\??\.sdk\s*[;,)]/g,
];
/**
 * Where the plugin does that, and how many times: asking.ts for review agents, and threads that are never review
 * agents. A new one anywhere, or one more in these files, fails until it goes through sendToAgent or spawnAgent.
 */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "src/asking.ts": { count: 2, why: "sendToAgent and spawnAgent, which mark what they send" },
  "src/fix-handoff.ts": { count: 1, why: "spawns a fixer, Fix in a new thread" },
  "src/generate.ts": { count: 2, why: "spawns the guide writer, and keeps bb.sdk.threads to stop it once the plugin is disposed" },
  "src/learning.ts": { count: 2, why: "spawns the Suggest instructions worker, through an alias" },
  "src/loop.ts": { count: 2, why: "Send: to the review's main thread, never one of the plugin's agents, or a fresh one it spawns" },
  "src/own-pr.ts": { count: 2, why: "forks the thread that wrote your PR as its fixer, and sends the fork its first message" },
};

test("only asking.ts sends to, spawns or queues for a thread, but where the thread is never a review agent, each as often as listed", () => {
  const found = Object.fromEntries(sources.map((file) => [file, STARTS_TURNS.reduce((n, pattern) => n + (read(file).match(pattern)?.length ?? 0), 0)]).filter(([, n]) => n));
  expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([file, { count }]) => [file, count])));
});

test("the pattern catches the ways around it", () => {
  const caught = (text: string) => STARTS_TURNS.some((pattern) => new RegExp(pattern.source).test(text));
  for (const text of ["(bb.sdk.threads as any).send({", "resend(bb.sdk.threads, input)", "bb.sdk.threads?.send({", 'bb.sdk.threads["send"]({', "threads.retry({", "bb.sdk.threads.queuedMessages.create({", "const t = bb.sdk.threads;", "const { threads } = bb.sdk;", "const sdk = bb.sdk;", 'bb.sdk["threads"].send', "threads.send.call(threads, {"]) {
    expect(caught(text), text).toBe(true);
  }
  expect(caught("bb.sdk.threads.queuedMessages.list({ threadId })")).toBe(false);
});

test("each feedback check says who started it: your click in the review, or the plugin on its own", () => {
  const kinds = sources.flatMap((file) => [...read(file).matchAll(/startVerification\(bb, store, [^;]*?"(ask|automatic)"(, \{ fixes: true \})?\)/g)].map((m) => `${file} ${m[1]}${m[2] ? " fixes" : ""}`)).sort();
  expect(kinds).toEqual([
    // A re-review coming back, pushes settling; and fixes coming back Ready to re-review (PC2), the only check of
    // fixes the plugin starts.
    "server.ts automatic", "server.ts automatic", "server.ts automatic fixes",
    "src/generate.ts automatic",
    // Check fixes and Check now, clicked.
    "src/reports.ts ask fixes",
    "src/turn-rpc.ts ask", "src/turn-rpc.ts ask",
  ]);
  expect(read("server.ts")).toMatch(/checkFixes: \(targetKey\) => startVerification\(bb, store, targetKey, [^;]*?"automatic", \{ fixes: true \}\)/);
  expect(read("src/reports.ts")).toMatch(/async checkFixes\(\{ targetKey \}\) \{[^]*?startVerification\(bb, store, targetKey, [^;]*?"ask", \{ fixes: true \}\)/);
  // Every call is caught: none is missed by the pattern.
  expect(sources.reduce((n, file) => n + (read(file).match(/\bstartVerification\(/g)?.length ?? 0), 0) - 1).toBe(kinds.length);
});
