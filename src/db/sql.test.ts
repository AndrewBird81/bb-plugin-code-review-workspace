import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sqliteSql } from "./sql";

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 1); });

function notes() {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const db = bb.storage.database();
  db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`);
  const executor = sqliteSql(db);
  const bodies = async () => (await executor.all<{ body: string }>(`SELECT body FROM notes ORDER BY id`)).map((row) => row.body);
  return { db, sql: executor, bodies, add: (body: string) => executor.run(`INSERT INTO notes (body) VALUES (?)`, [body]) };
}

test("all, get and run take positional parameters; run counts the rows it changed", async () => {
  const { sql, add } = notes();
  await add("a");
  await add("b");
  expect(await sql.all(`SELECT id, body FROM notes WHERE id >= ? ORDER BY id`, [1])).toEqual([{ id: 1, body: "a" }, { id: 2, body: "b" }]);
  expect(await sql.get(`SELECT body FROM notes WHERE id=?`, [2])).toEqual({ body: "b" });
  expect(await sql.get(`SELECT body FROM notes WHERE id=?`, [3])).toBeUndefined();
  expect(await sql.run(`UPDATE notes SET body=? WHERE id <= ?`, ["c", 2])).toEqual({ changes: 2 });
  expect(await sql.run(`INSERT INTO notes (id, body) VALUES (1, 'd') ON CONFLICT DO NOTHING`)).toEqual({ changes: 0 });
  expect(sql.dialect).toBe("sqlite");
});

test("a transaction commits once its function resolves, and gives its result", async () => {
  const { db, sql, add, bodies } = notes();
  await expect(sql.transaction(async () => {
    await add("a");
    expect(db.inTransaction).toBe(true);
    await add("b");
    return "done";
  })).resolves.toBe("done");
  expect(db.inTransaction).toBe(false);
  expect(await bodies()).toEqual(["a", "b"]);
});

test("a transaction whose function throws rolls back all it wrote, and the throw reaches its caller", async () => {
  const { db, sql, add, bodies } = notes();
  await add("before");
  await expect(sql.transaction(async () => {
    await add("a");
    await tick();
    await add("b");
    throw new Error("no");
  })).rejects.toThrow("no");
  expect(db.inTransaction).toBe(false);
  expect(await bodies()).toEqual(["before"]);
});

test("a nested transaction that throws rolls back only its own writes, and the outer one, catching it, commits the rest", async () => {
  const { sql, add, bodies } = notes();
  await sql.transaction(async () => {
    await add("outer before");
    await expect(sql.transaction(async () => {
      await add("inner");
      await sql.transaction(async () => { await add("innermost"); });
      throw new Error("inner failed");
    })).rejects.toThrow("inner failed");
    await sql.transaction(async () => { await add("second inner"); });
    await add("outer after");
  });
  expect(await bodies()).toEqual(["outer before", "second inner", "outer after"]);
});

test("a nested transaction's throw that the outer one doesn't catch rolls everything back, its committed savepoints too", async () => {
  const { db, sql, add, bodies } = notes();
  await expect(sql.transaction(async () => {
    await add("outer");
    await sql.transaction(async () => { await add("released"); });
    await sql.transaction(async () => {
      await add("inner");
      throw new Error("inner failed");
    });
  })).rejects.toThrow("inner failed");
  expect(db.inTransaction).toBe(false);
  expect(await bodies()).toEqual([]);
});

test("a nested transaction rolled back alone leaves its savepoint released, so the next one nests at the same depth", async () => {
  const { sql, add, bodies } = notes();
  await sql.transaction(async () => {
    for (const body of ["x", "y"]) {
      await sql.transaction(async () => { await add(body); throw new Error(body); }).catch(() => undefined);
    }
    await sql.transaction(async () => {
      await add("z");
      await sql.transaction(async () => { await add("deeper"); throw new Error("deeper"); }).catch(() => undefined);
    });
  });
  expect(await bodies()).toEqual(["z"]);
});

test("a statement from outside an open transaction waits for it to end, so a rollback doesn't take it", async () => {
  const { sql, add, bodies } = notes();
  const order: string[] = [];
  const failing = sql.transaction(async () => {
    await add("rolled back");
    order.push("transaction wrote");
    await tick();
    await tick();
    order.push("transaction throws");
    throw new Error("no");
  });
  await Promise.resolve();
  const outside = add("outside").then(() => { order.push("outside wrote"); });
  await expect(failing).rejects.toThrow("no");
  await outside;
  expect(order).toEqual(["transaction wrote", "transaction throws", "outside wrote"]);
  expect(await bodies()).toEqual(["outside"]);
});

test("transactions started together run one after the other, each committing or rolling back alone", async () => {
  const { sql, add, bodies } = notes();
  const results = await Promise.allSettled([
    sql.transaction(async () => { await add("first"); await tick(); }),
    sql.transaction(async () => { await add("second"); await tick(); throw new Error("second failed"); }),
    sql.transaction(async () => { await add("third"); }),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect(await bodies()).toEqual(["first", "third"]);
});

test("work a transaction started without awaiting, still running once it ended, waits like any statement from outside", async () => {
  const { sql, add, bodies } = notes();
  let late: Promise<unknown> | undefined;
  await sql.transaction(async () => {
    await add("inside");
    late = tick().then(() => add("late"));
  });
  const next = sql.transaction(async () => {
    await add("next");
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    throw new Error("next failed");
  });
  await expect(next).rejects.toThrow("next failed");
  await late;
  expect(await bodies()).toEqual(["inside", "late"]);
});

test("stores sharing a database handle share its executor, so they wait for each other's transactions", () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  expect(sqliteSql(bb.storage.database())).toBe(sqliteSql(bb.storage.database()));
});
