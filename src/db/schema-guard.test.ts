import { expect, test } from "vitest";
import { assertMigrationLedger, statementHash } from "./schema-guard";

test("migration hashes use SHA-256 of the exact statement text", () => {
  expect(statementHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(statementHash("abc ")).not.toBe(statementHash("abc"));
});

test("the guard accepts the shared hash and refuses an edited statement", () => {
  const ledger = [{ id: 0, statement_hash: statementHash("abc") }];
  expect(() => assertMigrationLedger(ledger, ["abc"], "SQLite")).not.toThrow();
  expect(() => assertMigrationLedger(ledger, ["abc "], "SQLite")).toThrow("SQLite migration 0 does not match");
});
