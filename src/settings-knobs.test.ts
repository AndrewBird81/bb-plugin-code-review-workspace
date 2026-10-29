import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { AUTOMATIC_REVIEW_BEFORE_PRECISION, VERIFICATION_PROMPT_BEFORE_OPEN_THREADS, automaticReviewPrompt, defaultPreferences, preferencesSchema, reReviewCheckPrompt, readKnobs } from "./preferences";
import { defaultKnobs, type Knobs } from "../lib/knobs";
import { testSql, testStore } from "./test-store.test-support";

/** The knobs as the column keeps them while 1.8.0's switches are at their defaults. */
const withoutSwitches = ({ reviewAgentActs: _agent, reviewChangesLine: _line, trackOwnPrs: _own, ...rest }: Knobs) => rest;

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const sql = testSql(bb);
  const row = async () => (await sql.get<{ value: string; revision: number; knobs: string | null }>(`SELECT value,revision,knobs FROM review_preferences WHERE id=1`))!;
  return { bb, harness, sql, row, call: (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any> };
}

test("a fresh store reads every setting and knob at its default, as fresh copies", async () => {
  const { bb } = await host();
  const { preferences, revision } = await testStore(bb).getPreferences();
  expect(preferences).toEqual(defaultPreferences);
  expect(preferences.knobs).toEqual(defaultKnobs);
  expect(preferences.knobs).not.toBe(defaultKnobs);
  expect(revision).toBe(0);
});

test("knobs save and load through the RPC in their own column, and a stale edit is still rejected", async () => {
  const { bb, call, row } = await host();
  const knobs = { ...defaultKnobs, singleKeyShortcuts: false, approveGuardPace: 800 };
  const saved = await call("savePreferences", { preferences: { ...defaultPreferences, guideDetail: "detailed", knobs }, revision: 0 });
  expect(saved).toEqual({ preferences: { ...defaultPreferences, guideDetail: "detailed", knobs }, revision: 1 });
  expect((await call("getPreferences", null)).preferences.knobs).toEqual(knobs);
  expect((await testStore(bb).getPreferences()).preferences.knobs).toEqual(knobs);
  await expect(call("savePreferences", { preferences: { ...defaultPreferences, knobs }, revision: 0 })).rejects.toThrow(/changed/);
  // value stays what 0.6.0's strict schema reads.
  const value = JSON.parse((await row()).value);
  expect(value).not.toHaveProperty("knobs");
  expect(() => preferencesSchema.omit({ knobs: true }).parse(value)).not.toThrow();
  expect(JSON.parse((await row()).knobs!)).toEqual(withoutSwitches(knobs));
});

test("settings saved before knobs still load unchanged, with every knob at its default", async () => {
  const { bb, sql } = await host();
  const { knobs: _none, ...older } = { ...defaultPreferences, guideDetail: "concise" as const, guideInstructions: "Explain migrations", diffLayout: "unified" as const,
    wakeOnReplies: "any" as const, pushChecks: "ready" as const, trackTeamRequests: true, autoStartRepos: ["acme/web", "acme/*"], unattendedAuthors: "anyone" as const,
    runRepoChecks: true, threadListReviews: false, rereviewShows: "all" as const, automaticReview: "", verificationPrompt: "Check it" };
  await sql.run(`INSERT INTO review_preferences (id,value,revision) VALUES (1,?,4)`, [JSON.stringify(older)]);
  expect(await testStore(bb).getPreferences()).toEqual({ preferences: { ...older, knobs: defaultKnobs }, revision: 4 });
});

test("knobs survive a rollback to 0.6.0, whose save writes only value and revision", async () => {
  const { bb, call, sql } = await host();
  const knobs = { ...defaultKnobs, alertTurns: false };
  const saved = await call("savePreferences", { preferences: { ...defaultPreferences, knobs }, revision: 0 });
  await sql.run(`UPDATE review_preferences SET value=?,revision=revision+1 WHERE id=1 AND revision=?`, [JSON.stringify({ ...defaultPreferences, knobs: undefined, guideDetail: "detailed" }), saved.revision]);
  expect((await testStore(bb).getPreferences()).preferences).toMatchObject({ guideDetail: "detailed", knobs });
});

test("missing and invalid knobs read at their defaults, and unknown ones are dropped", async () => {
  const { bb, sql } = await host();
  await sql.run(`INSERT INTO review_preferences (id,value,revision,knobs) VALUES (1,?,1,?)`, [JSON.stringify({}), JSON.stringify({ approveGuardPace: 99999, alertTurns: "yes", bogus: 1, codeOwners: false })]);
  expect((await testStore(bb).getPreferences()).preferences.knobs).toEqual({ ...defaultKnobs, codeOwners: false });
  await sql.run(`UPDATE review_preferences SET knobs=? WHERE id=1`, ["{not json"]);
  expect((await testStore(bb).getPreferences()).preferences.knobs).toEqual(defaultKnobs);
  for (const saved of [null, undefined, "[]", "3", [], 3, { approveGuardPace: 150.5 }]) expect(readKnobs(saved)).toEqual(defaultKnobs);
  expect(readKnobs({ approveGuardPace: 100 }).approveGuardPace).toBe(100);
});

test("a save keeps knobs a newer version saved, so a rollback and a settings save don't erase them", async () => {
  const { call, sql, row } = await host();
  await sql.run(`INSERT INTO review_preferences (id,value,revision,knobs) VALUES (1,?,1,?)`, [JSON.stringify({}), JSON.stringify({ codeOwners: false, futureKnob: 7, __proto__x: true })]);
  await call("savePreferences", { preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, requirements: false } }, revision: 1 });
  expect(JSON.parse((await row()).knobs!)).toEqual({ ...withoutSwitches(defaultKnobs), requirements: false, futureKnob: 7, __proto__x: true });
  expect((await call("getPreferences", null)).preferences.knobs).toEqual({ ...defaultKnobs, requirements: false });
});

test("1.8.0's switches are saved only while they differ from their defaults, so a changed default reaches whoever saved Settings", async () => {
  const { call, row } = await host();
  let saved = await call("savePreferences", { preferences: defaultPreferences, revision: 0 });
  expect(JSON.parse((await row()).knobs!)).toEqual(withoutSwitches(defaultKnobs));
  // As a 1.8.1 that turns the review agent's posting off by default would.
  defaultKnobs.reviewAgentActs = false;
  try {
    expect((await call("getPreferences", null)).preferences.knobs.reviewAgentActs).toBe(false);
    // Turned on, it's saved, and stays on whatever the default.
    saved = await call("savePreferences", { preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, reviewAgentActs: true, trackOwnPrs: false } }, revision: saved.revision });
    expect(JSON.parse((await row()).knobs!)).toMatchObject({ reviewAgentActs: true, trackOwnPrs: false });
  } finally { defaultKnobs.reviewAgentActs = true; }
  expect((await call("getPreferences", null)).preferences.knobs).toEqual({ ...defaultKnobs, trackOwnPrs: false });
  await call("savePreferences", { preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, trackOwnPrs: false } }, revision: saved.revision });
  expect(JSON.parse((await row()).knobs!)).toEqual({ ...withoutSwitches(defaultKnobs), trackOwnPrs: false });
});

test("a save without knobs keeps the saved ones, a partial one merges, and an invalid one is rejected", async () => {
  const { call } = await host();
  let saved = await call("savePreferences", { preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, mentionsWake: false } }, revision: 0 });
  // A page from before knobs.
  const { knobs: _none, ...older } = { ...defaultPreferences, guideDetail: "detailed" as const };
  saved = await call("savePreferences", { preferences: older, revision: saved.revision });
  expect(saved.preferences).toMatchObject({ guideDetail: "detailed", knobs: { ...defaultKnobs, mentionsWake: false } });
  saved = await call("savePreferences", { preferences: { ...older, knobs: { requirements: false } }, revision: saved.revision });
  expect(saved.preferences.knobs).toEqual({ ...defaultKnobs, mentionsWake: false, requirements: false });
  for (const knobs of [{ approveGuardPace: 99 }, { approveGuardPace: 2001 }, { approveGuardPace: 500.5 }, { alertTurns: "no" }, { bogus: true }]) {
    await expect(call("savePreferences", { preferences: { ...older, knobs }, revision: saved.revision })).rejects.toThrow();
  }
  expect((await call("getPreferences", null)).revision).toBe(saved.revision);
});

test("the automatic review and re-review check prompts are blank when their knob is off, and trimmed when on", () => {
  const preferences = { ...defaultPreferences, automaticReview: "  Review it \n", verificationPrompt: "\n Check it  " };
  expect(automaticReviewPrompt(preferences)).toBe("Review it");
  expect(reReviewCheckPrompt(preferences)).toBe("Check it");
  const off = { ...preferences, knobs: { ...defaultKnobs, runAutomaticReview: false, runReReviewCheck: false } };
  expect(automaticReviewPrompt(off)).toBe("");
  expect(reReviewCheckPrompt(off)).toBe("");
  expect(automaticReviewPrompt({ ...preferences, automaticReview: "  " })).toBe("");
});

test("one invalid saved setting reads at its default, and the rest keep their saved values", async () => {
  const { bb, sql } = await host();
  await sql.run(`INSERT INTO review_preferences (id,value,revision) VALUES (1,?,1)`, [JSON.stringify({
    ...defaultPreferences, knobs: undefined, guideDetail: "verbose", guideInstructions: "Explain migrations", autoStartRepos: ["acme/web", "not a repo", 7, " Acme/* "], bogus: true,
    automaticReview: AUTOMATIC_REVIEW_BEFORE_PRECISION, verificationPrompt: VERIFICATION_PROMPT_BEFORE_OPEN_THREADS, assistantInstructions: "x".repeat(2500),
  })]);
  const { preferences } = await testStore(bb).getPreferences();
  expect(preferences).toEqual({ ...defaultPreferences, guideInstructions: "Explain migrations", autoStartRepos: ["acme/web", "acme/*"], assistantInstructions: "x".repeat(2000) });
  expect(preferences).not.toHaveProperty("bogus");
  await sql.run(`UPDATE review_preferences SET value=?`, [JSON.stringify({ guideDetail: "concise", autoStartRepos: "acme/web", wakeOnReplies: null })]);
  expect((await testStore(bb).getPreferences()).preferences).toEqual({ ...defaultPreferences, guideDetail: "concise" });
  for (const value of ["{not json", "[1]", "null", "3"]) {
    await sql.run(`UPDATE review_preferences SET value=?`, [value]);
    expect((await testStore(bb).getPreferences()).preferences).toEqual(defaultPreferences);
  }
  // A fallback is a fresh copy, which a caller can't change for everyone.
  expect((await testStore(bb).getPreferences()).preferences.autoStartRepos).not.toBe(defaultPreferences.autoStartRepos);
});
