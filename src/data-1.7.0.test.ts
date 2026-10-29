// Reviews 1.7.0 wrote load as they were: src/fixtures/1.7.0 is scripts/fixture-1.7.0.ts's output from a v1.7.0 checkout,
// the rows it wrote, every Store read 1.7.0 gave of them, and what each draft posted to GitHub.
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { queueStore } from "./store-queue";
import { toGithubReviewPayload } from "./draft";
import { dumpDatabase } from "../scripts/store-reads";

// The fixture is a data.db's rows: the Store reads it on SQLite, whatever the test backend.
vi.unmock("./store");

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "1.7.0", name), "utf8");
const [TEAMMATE, OWN, LOCAL] = Object.keys(JSON.parse(fixture("payloads.json")));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A host whose database holds the rows 1.7.0 wrote, on the tables 1.8.0 migrates. */
function host() {
  const made = createFakePluginHost({ pluginId: "code-review-workspace" });
  createStore(made.bb);
  made.bb.storage.database().exec(fixture("data.sql"));
  return made;
}

test("every Store read of reviews 1.7.0 wrote gives what 1.7.0's gave, but the knobs 1.8.0 adds, at their defaults", async () => {
  const { bb, harness } = host();
  const dir = mkdtempSync(join(tmpdir(), "data-1.7.0-"));
  dirs.push(dir);
  bb.storage.database().prepare(`VACUUM INTO ?`).run(join(dir, "data.db"));
  await harness.dispose();
  const reads = JSON.parse((await dumpDatabase(join(dir, "data.db"))).reads);
  const read170 = JSON.parse(fixture("reads.json"));
  // 1.7.0's settings turned Code owners off; 1.8.0's switches read on.
  expect(read170.global.getPreferences.preferences.knobs.codeOwners).toBe(false);
  read170.global.getPreferences.preferences.knobs = { ...read170.global.getPreferences.preferences.knobs, reviewAgentActs: true, reviewChangesLine: true, trackOwnPrs: true };
  expect(reads).toEqual(read170);
});

test("each draft 1.7.0 wrote posts the same review, byte for byte, and what it sent to threads reads as it stored it", async () => {
  const { bb, harness } = host();
  const store = queueStore(createStore(bb));
  const payloads = JSON.parse(fixture("payloads.json"));
  for (const k of [TEAMMATE, OWN, LOCAL]) {
    const draft = await store.getDraft(k);
    expect({ k, plain: JSON.stringify(toGithubReviewPayload(draft, false, false)), preExisting: JSON.stringify(toGithubReviewPayload(draft, true, false)) }).toEqual({ k, ...payloads[k] });
    // A comment with no state is open: none gains one by loading.
    expect(draft.comments.filter((c) => "id" in c || "state" in c || "sendN" in c || "claim" in c)).toEqual([]);
  }
  const stored = (k: string) => JSON.parse((bb.storage.database().prepare(`SELECT state FROM review_lifecycle WHERE target_key=?`).get(k) as { state: string }).state);
  await plugin(bb);
  const review = async (k: string) => (await harness.behavior.callRpc("getReviewBundle", { targetKey: k }) as { review: Record<string, unknown> }).review;
  expect(stored(OWN).sent.comments).toHaveLength(1);
  expect((await review(OWN)).sent).toEqual(stored(OWN).sent);
  expect((await review(LOCAL)).approvalSent).toEqual(stored(LOCAL).approvalSent);
  const listed = (await harness.behavior.callRpc("listReviews", null) as { reviews: Array<Record<string, unknown>> }).reviews;
  expect(listed.find((r) => r.targetKey === OWN)?.sent).toEqual(stored(OWN).sent);
});
