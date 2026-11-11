import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { defaultPreferences, readPreferences } from "./preferences";
import { testSql, testStore } from "./test-store.test-support";
import { REVIEW_TABLES } from "./store";
import plugin from "../server";

const defaults = { enabled: false, githubLabel: true, focuses: [{ id: "docs", label: "Docs", enabled: true, template: "docs" }] };

test("focus settings default off, read fields independently, and discard unknown fields", () => {
  expect(defaultPreferences.focuses).toEqual(defaults);
  expect(readPreferences({}).focuses).toEqual(defaults);
  expect(readPreferences({}, null, "not json").focuses).toEqual(defaults);
  expect(readPreferences({}, null, JSON.stringify({ enabled: true, focuses: "bad", future: true })).focuses).toEqual({ ...defaults, enabled: true });
  expect(readPreferences({}, null, { enabled: "bad", focuses: [], future: true }).focuses).toEqual({ ...defaults, focuses: [] });
  expect(readPreferences({}, null, { ...defaults, focuses: [{ ...defaults.focuses[0], future: true }] }).focuses).toEqual(defaults);
  expect(readPreferences({}, null, { ...defaults, focuses: [{ id: "docs", label: 1 }] }).focuses).toEqual(defaults);
});

test.each(["**", "\n", "@x"])("unsafe focus label %j is rejected on save and defaults independently on read", async (label) => {
  const focuses = { enabled: true, githubLabel: false, focuses: [{ ...defaults.focuses[0], label }] };
  expect(readPreferences({}, null, focuses).focuses).toEqual({ ...focuses, focuses: defaults.focuses });
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  await expect(harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, focuses }, revision: 0 })).rejects.toThrow();
  await harness.lifecycle.dispose();
});

test("focus labels are trimmed and accept letters, numbers and safe punctuation", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const focuses = { ...defaults, focuses: [{ ...defaults.focuses[0], label: "  文档 2._-  " }] };
  const result = await harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, focuses }, revision: 0 }) as any;
  expect(result.preferences.focuses.focuses[0].label).toBe("文档 2._-");
  await harness.lifecycle.dispose();
});

test("githubLabel defaults per field; a page from Phase 0/1 keeps the saved label setting", async () => {
  expect(readPreferences({}, null, { enabled: true, githubLabel: "bad", focuses: [] }).focuses).toEqual({ enabled: true, githubLabel: true, focuses: [] });
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.savePreferences({ ...defaultPreferences, focuses: { ...defaults, githubLabel: false } }, 0);
  const { githubLabel: _omitted, ...older } = defaults;
  const saved = await harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, focuses: { ...older, enabled: true } }, revision: 1 }) as any;
  expect(saved.preferences.focuses).toEqual({ ...defaults, enabled: true, githubLabel: false });
  expect((await store.getPreferences()).preferences.focuses.githubLabel).toBe(false);
  await harness.lifecycle.dispose();
});

test("focus settings save apart from value; a pre-focus build's save leaves the column intact", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb), sql = testSql(bb);
  const focuses = { ...defaults, enabled: true, githubLabel: false };
  await store.savePreferences({ ...defaultPreferences, focuses }, 0);
  expect((await store.getPreferences()).preferences.focuses).toEqual(focuses);
  const row = await sql.get<{ value: string; focuses: string }>(`SELECT value, focuses FROM review_preferences WHERE id=1`);
  expect(JSON.parse(row!.value)).not.toHaveProperty("focuses");
  expect(JSON.parse(row!.focuses)).toEqual(focuses);
  // An older build updates only the two columns it knows, as the pre-focus Store does.
  await sql.run(`UPDATE review_preferences SET value=?,knobs=?,revision=revision+1 WHERE id=1 AND revision=?`, [row!.value, "{}", 1]);
  expect((await store.getPreferences()).preferences.focuses).toEqual(focuses);
  await expect(store.savePreferences({ ...defaultPreferences, focuses }, 1)).rejects.toThrow(/changed/);
  await harness.lifecycle.dispose();
});

test("pre-focus pages keep the saved settings, and focus saves drop fields this build does not know", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  const focuses = { ...defaults, enabled: true };
  await store.savePreferences({ ...defaultPreferences, focuses }, 0);
  const { focuses: _omitted, ...older } = defaultPreferences;
  const saved = await harness.behavior.callRpc("savePreferences", { preferences: older, revision: 1 }) as any;
  expect(saved.preferences.focuses).toEqual(focuses);
  const future = { ...focuses, mergeEffort: "high", focuses: [{ ...focuses.focuses[0], agent: { model: "future" } }] };
  await store.savePreferences({ ...defaultPreferences, focuses: future }, 2);
  expect((await store.getPreferences()).preferences.focuses).toEqual(focuses);
  for (const invalid of [{ enabled: "yes", focuses: [] }, { enabled: true, focuses: Array(13).fill(defaults.focuses[0]) }]) {
    await expect(harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, focuses: invalid }, revision: 3 })).rejects.toThrow();
  }
  await harness.lifecycle.dispose();
});

test("focus tables allow future statuses, discard merged findings, move identities, and delete with their review", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb), sql = testSql(bb);
  for (const targetKey of ["from", "into"]) {
    await store.saveReview({ targetKey, kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1 });
    await sql.run(`INSERT INTO focus_threads (thread_id,target_key,run_id,focus_id,label,created_at) VALUES (?,?,?,?,?,?)`, [`thread-${targetKey}`, targetKey, "run", "docs", "Docs", 1]);
    await sql.run(`INSERT INTO focus_findings (target_key,run_id,id,focus_id,label,file,line,side,start_line,start_side,severity,body,evidence,introduced,status,reason,note,draft_file,draft_line,draft_side,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [targetKey, "run", "f1", "docs", "Docs", "a.ts", 2, "RIGHT", 1, "RIGHT", "nit", "Wrong docs", "a.ts:2", 1, "future-status", null, null, "a.ts", 3, "RIGHT", 4]);
  }
  expect(REVIEW_TABLES).toContain("focus_threads");
  expect(REVIEW_TABLES).toContain("focus_findings");
  await store.mergeReview("from", "into");
  expect(await sql.all(`SELECT target_key FROM focus_threads ORDER BY thread_id`)).toEqual([{ target_key: "into" }, { target_key: "into" }]);
  expect(await sql.all(`SELECT target_key,draft_file,draft_line,draft_side FROM focus_findings`)).toEqual([{ target_key: "into", draft_file: "a.ts", draft_line: 3, draft_side: "RIGHT" }]);
  await store.deleteReview("into");
  expect(await sql.all(`SELECT * FROM focus_threads`)).toEqual([]);
  expect(await sql.all(`SELECT * FROM focus_findings`)).toEqual([]);
  await harness.lifecycle.dispose();
});
