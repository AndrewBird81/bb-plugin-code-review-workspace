import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test, vi } from "vitest";
import { createStore, SQLITE_MIGRATIONS } from "./store";
import plugin from "../server";

vi.unmock("./store");

for (const legacy of [false, true]) {
  test(`a future SQLite ledger is refused without writes (legacy=${legacy})`, async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
    const db = bb.storage.database();
    db.exec(`CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL${legacy ? "" : ", statement_hash TEXT"})`);
    db.prepare(`INSERT INTO _bb_migrations (id, applied_at) VALUES (?, 1)`).run(SQLITE_MIGRATIONS.length);
    const before = db.serialize();
    const migrate = vi.spyOn(bb.storage, "migrate");
    await expect(plugin(bb)).rejects.toThrow(`database is from a newer Code Review Workspace (migration ${SQLITE_MIGRATIONS.length}); update the plugin`);
    expect(migrate).not.toHaveBeenCalled();
    expect(db.serialize()).toEqual(before);
    await harness.lifecycle.dispose();
  });
}

test("a changed SQLite hash refuses before the host migrator or Store writes", () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const db = bb.storage.database();
  bb.storage.migrate(db, SQLITE_MIGRATIONS.slice(0, 40));
  db.prepare("UPDATE _bb_migrations SET statement_hash = 'changed' WHERE id = 3").run();
  const before = db.serialize();
  const migrate = vi.spyOn(bb.storage, "migrate");
  expect(() => createStore(bb)).toThrow("SQLite migration 3 does not match");
  expect(migrate).not.toHaveBeenCalled();
  expect(db.serialize()).toEqual(before);
});

test("missing trailing SQLite migrations upgrade through the host, preserving existing ledger rows", () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const db = bb.storage.database();
  bb.storage.migrate(db, SQLITE_MIGRATIONS.slice(0, 40));
  const before = db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all();
  const migrate = vi.spyOn(bb.storage, "migrate");
  createStore(bb);
  expect(migrate).toHaveBeenCalledWith(db, SQLITE_MIGRATIONS);
  const after = db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all();
  expect(after.slice(0, 40)).toEqual(before);
  expect(after).toHaveLength(SQLITE_MIGRATIONS.length);
});

test("a legacy SQLite ledger without hashes still upgrades normally", () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const db = bb.storage.database();
  bb.storage.migrate(db, SQLITE_MIGRATIONS.slice(0, 40));
  db.exec("ALTER TABLE _bb_migrations DROP COLUMN statement_hash");
  createStore(bb);
  expect(db.prepare("SELECT count(*) AS n FROM _bb_migrations").get()).toEqual({ n: SQLITE_MIGRATIONS.length });
});
