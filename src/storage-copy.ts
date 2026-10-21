// The Store's tables, copied between the plugin's SQLite database and Postgres, and checked to hold the same rows: what
// the storage CLI (src/storage-cli.ts) moves the reviews with. Rows go in pages of a few MB, by the size of their text,
// so a whole patch is held once or twice at a time, never every patch at once.
//
// A table's checksum is the SHA-256 of its rows in primary-key order, each row its values in column-name order, then a
// newline. Each value says its type: n; for NULL, i<digits>; for an integer, t<bytes>:<UTF-8> for text (r and b for
// SQLite's REAL and BLOB, which the Store doesn't keep). Text keys sort by code point on both sides: SQLite's BINARY,
// Postgres's COLLATE "C". A table with an id that AUTOINCREMENT (Postgres: an identity) hands out is also checked for
// the next id it would give.
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PgSql } from "./db/pg";
import { PG_MIGRATIONS } from "./db/pg-migrations";
import type { SqlValue } from "./db/sql";
import { SQLITE_MIGRATIONS } from "./store";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** A Store table: its columns by name, as SQLite declares them, its primary key, and the id AUTOINCREMENT hands out. */
export interface Table {
  name: string;
  /** Sorted by name. */
  columns: Array<{ name: string; type: "integer" | "text" | string }>;
  key: string[];
  identity: string | null;
}

/** Each Postgres column's type, by `table.column`: bigint, integer, smallint or text. */
export type PgTypes = Map<string, string>;

export interface TableSum { rows: number; sha256: string }

export interface Checksums {
  tables: Map<string, TableSum>;
  /** For each table with an identity, the id its next row gets. */
  nextIds: Map<string, number>;
}

/** Problems found before anything was written, or a copy that didn't check out. */
export class StorageProblems extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "StorageProblems";
  }
}

/** The command was cancelled, or the plugin is reloading, before it finished. */
export class StorageStopped extends Error {
  constructor() {
    super("Stopped before it finished, as the plugin is reloading or the command was cancelled");
    this.name = "StorageStopped";
  }
}

export function stopIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new StorageStopped();
}

// What a page of rows may hold: its text's bytes (a row bigger than this is a page of its own), and its values, which
// Postgres caps at 65,535 parameters a statement.
const PAGE_BYTES = 4 * 1024 * 1024;
const PAGE_VALUES = 30_000;

/** Tables in data.db that aren't the Store's: BB's migrations record, and plugin_updates, which stays in SQLite. */
const SQLITE_ONLY = new Set(["_bb_migrations", "plugin_updates"]);

const quote = (name: string) => `"${name.replaceAll(`"`, `""`)}"`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const INTEGER_RANGES: Record<string, readonly [number, number]> = {
  smallint: [-32_768, 32_767],
  integer: [-2_147_483_648, 2_147_483_647],
  // Postgres's bigint holds more, but the Store reads each value as a JavaScript number.
  bigint: [-MAX_SAFE, MAX_SAFE],
};

/** The Store's tables in the SQLite database `schema`: main, or one attached. */
export function sqliteTables(db: Database, schema = "main"): Table[] {
  const tables = db.prepare(`SELECT name, sql FROM ${quote(schema)}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string; sql: string }>;
  return tables.filter((table) => !SQLITE_ONLY.has(table.name)).map(({ name, sql }) => {
    const info = db.prepare(`SELECT name, type, pk FROM pragma_table_info(?, ?)`).all(name, schema) as Array<{ name: string; type: string; pk: number }>;
    const key = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    return {
      name,
      columns: info.map((column) => ({ name: column.name, type: column.type.toLowerCase() })).sort(byName),
      key,
      identity: /\bAUTOINCREMENT\b/i.test(sql) && key.length === 1 ? key[0]! : null,
    };
  });
}

/** The Store's tables in Postgres schema `schema`, with their columns' types. */
export async function pgTables(sql: PgSql, schema: string): Promise<{ tables: Table[]; types: PgTypes }> {
  const columns = await sql.all<{ table_name: string; column_name: string; data_type: string; is_identity: string }>(
    `SELECT c.table_name, c.column_name, c.data_type, c.is_identity FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = ? AND c.table_name <> 'crw_migrations' ORDER BY c.table_name, c.column_name`, [schema]);
  const keys = await sql.all<{ table_name: string; column_name: string }>(
    `SELECT k.table_name, k.column_name FROM information_schema.table_constraints c
      JOIN information_schema.key_column_usage k ON k.constraint_schema = c.constraint_schema AND k.constraint_name = c.constraint_name AND k.table_name = c.table_name
      WHERE c.table_schema = ? AND c.constraint_type = 'PRIMARY KEY' ORDER BY k.table_name, k.ordinal_position`, [schema]);
  const types: PgTypes = new Map();
  const tables = new Map<string, Table>();
  for (const column of columns) {
    let table = tables.get(column.table_name);
    if (!table) tables.set(column.table_name, table = { name: column.table_name, columns: [], key: [], identity: null });
    table.columns.push({ name: column.column_name, type: column.data_type === "text" ? "text" : column.data_type in INTEGER_RANGES ? "integer" : column.data_type });
    types.set(`${column.table_name}.${column.column_name}`, column.data_type);
    if (column.is_identity === "YES") table.identity = column.column_name;
  }
  for (const key of keys) tables.get(key.table_name)?.key.push(key.column_name);
  for (const table of tables.values()) table.columns.sort(byName);
  return { tables: [...tables.values()].sort(byName), types };
}

function byName(a: { name: string }, b: { name: string }) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Where SQLite's tables and Postgres's differ: in name, columns, column types, primary key, or identity. */
export function schemaProblems(sqlite: Table[], postgres: Table[]): string[] {
  const problems: string[] = [];
  const inPostgres = new Map(postgres.map((table) => [table.name, table]));
  const describeColumns = (table: Table) => table.columns.map((column) => `${column.name} ${column.type}`).join(", ");
  for (const table of sqlite) {
    const other = inPostgres.get(table.name);
    inPostgres.delete(table.name);
    if (!other) {
      problems.push(`Table ${table.name} is in SQLite but not in Postgres.`);
    } else if (describeColumns(table) !== describeColumns(other)) {
      problems.push(`Table ${table.name} has columns ${describeColumns(table)} in SQLite, but ${describeColumns(other)} in Postgres.`);
    } else if (table.key.join(", ") !== other.key.join(", ") || table.identity !== other.identity) {
      problems.push(`Table ${table.name}'s primary key is (${table.key.join(", ")})${table.identity ? `, ${table.identity} autoincrementing` : ""} in SQLite, but (${other.key.join(", ")})${other.identity ? `, ${other.identity} an identity` : ""} in Postgres.`);
    }
  }
  for (const name of inPostgres.keys()) problems.push(`Table ${name} is in Postgres but not in SQLite.`);
  return problems;
}

/** How a migrations record differs from `statements`: each index applied once, as the statement at that index. */
function migrationProblems(where: string, applied: Array<{ id: number; statement_hash: string | null }>, statements: readonly string[]): string[] {
  const problems: string[] = [];
  const ids = new Set(applied.map((row) => row.id));
  const missing = statements.map((_, id) => id).filter((id) => !ids.has(id));
  if (missing.length) problems.push(`${where} lacks migration${missing.length > 1 ? "s" : ""} ${missing.join(", ")} of this version's ${statements.length}.`);
  for (const { id, statement_hash: hash } of applied) {
    if (id < 0 || id >= statements.length) problems.push(`${where} has migration ${id}, which this version doesn't have: a newer version made it.`);
    else if (hash !== null && hash !== sha256(statements[id]!)) problems.push(`${where}'s migration ${id} isn't this version's.`);
  }
  return problems;
}

/** How SQLite's migrations differ from this version's. */
export function sqliteMigrationProblems(db: Database, schema = "main"): string[] {
  const where = schema === "main" ? "SQLite's data.db" : "The SQLite export";
  if (!db.prepare(`SELECT 1 FROM ${quote(schema)}.sqlite_master WHERE type='table' AND name='_bb_migrations'`).get()) {
    return [`${where} has none of the Store's tables: the plugin hasn't kept its reviews there.`];
  }
  return migrationProblems(where, db.prepare(`SELECT id, statement_hash FROM ${quote(schema)}._bb_migrations ORDER BY id`).all() as Array<{ id: number; statement_hash: string | null }>, SQLITE_MIGRATIONS);
}

/** How Postgres's migrations, in `schema`, differ from this version's. */
export async function pgMigrationProblems(sql: PgSql, schema: string): Promise<string[]> {
  const where = `Postgres schema "${schema}"`;
  if (!await sql.get(`SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = 'crw_migrations'`, [schema])) {
    return [`${where} has none of the Store's tables: no reviews were copied there.`];
  }
  return migrationProblems(where, await sql.all<{ id: number; statement_hash: string }>(`SELECT id, statement_hash FROM crw_migrations ORDER BY id`), PG_MIGRATIONS);
}

/** The values in SQLite that Postgres can't hold as they are, or that wouldn't come back as they were. */
export function sqliteValueProblems(db: Database, tables: Table[], types: PgTypes): string[] {
  const problems: string[] = [];
  const count = (text: string, ...params: SqlValue[]) => (db.prepare(text).get(...params) as { n: number }).n;
  for (const table of tables) {
    const from = `FROM ${quote(table.name)}`;
    const texts: string[] = [];
    for (const { name, type } of table.columns) {
      const column = quote(name);
      const at = `${table.name}.${name}`;
      const wrong = count(`SELECT count(*) AS n ${from} WHERE ${column} IS NOT NULL AND typeof(${column}) <> ?`, type);
      if (wrong) problems.push(`${at}: ${wrong} value${wrong > 1 ? "s aren't" : " isn't"} ${type === "integer" ? "an integer" : "text"}, as the column is.`);
      if (type === "text") {
        texts.push(name);
        continue;
      }
      const [low, high] = INTEGER_RANGES[types.get(at) ?? "bigint"] ?? INTEGER_RANGES.bigint!;
      const out = count(`SELECT count(*) AS n ${from} WHERE typeof(${column}) = 'integer' AND (${column} < ? OR ${column} > ?)`, low, high);
      if (out) problems.push(`${at}: ${out} value${out > 1 ? "s are" : " is"} outside ${low} to ${high}, which Postgres's ${types.get(at) ?? "bigint"} column and the Store hold.`);
    }
    if (!texts.length) continue;
    // Each text's bytes, as SQLite keeps them: JavaScript would read invalid UTF-8 as U+FFFD, and the checksums with it.
    const select = db.prepare(`SELECT ${texts.map((name) => `CASE WHEN typeof(${quote(name)}) = 'text' THEN CAST(${quote(name)} AS BLOB) END`).join(", ")} ${from}`).raw(true);
    const nul = new Map<string, number>(), invalid = new Map<string, number>();
    for (const row of select.iterate() as Iterable<Array<Buffer | null>>) {
      row.forEach((bytes, index) => {
        if (!bytes) return;
        const name = texts[index]!;
        if (bytes.includes(0)) nul.set(name, (nul.get(name) ?? 0) + 1);
        else if (!isUtf8(bytes)) invalid.set(name, (invalid.get(name) ?? 0) + 1);
      });
    }
    for (const [name, n] of nul) problems.push(`${table.name}.${name}: ${n} value${n > 1 ? "s hold" : " holds"} a NUL character (U+0000), which Postgres's text can't.`);
    for (const [name, n] of invalid) problems.push(`${table.name}.${name}: ${n} value${n > 1 ? "s aren't" : " isn't"} valid UTF-8, which Postgres's text must be.`);
  }
  return problems;
}

/** Postgres's tables that hold rows already, as "name (n rows)". */
export async function pgTablesWithRows(sql: PgSql, tables: Table[]): Promise<string[]> {
  const held: string[] = [];
  for (const table of tables) {
    const { n } = (await sql.get<{ n: number }>(`SELECT count(*) AS n FROM ${quote(table.name)}`))!;
    if (n) held.push(`${table.name} (${n} row${n > 1 ? "s" : ""})`);
  }
  return held;
}

/** Runs of consecutive rows, from their sizes, each at most PAGE_BYTES (or a single row) and PAGE_VALUES values. */
function pages(sizes: readonly number[], columns: number): Array<{ offset: number; limit: number }> {
  const most = Math.max(1, Math.floor(PAGE_VALUES / columns));
  const found: Array<{ offset: number; limit: number }> = [];
  let offset = 0, limit = 0, bytes = 0;
  sizes.forEach((size, row) => {
    if (limit && (bytes + size > PAGE_BYTES || limit >= most)) {
      found.push({ offset, limit });
      offset = row;
      limit = 0;
      bytes = 0;
    }
    limit++;
    bytes += size;
  });
  if (limit) found.push({ offset, limit });
  return found;
}

/** A row's size, as the bytes of its text, plus 8 for each integer. */
function sizeOf(table: Table, length: (column: string) => string): string {
  const integers = table.columns.filter((column) => column.type !== "text").length;
  return [...table.columns.filter((column) => column.type === "text").map((column) => `COALESCE(${length(quote(column.name))}, 0)`), String(8 * integers)].join(" + ");
}

const columnList = (table: Table) => table.columns.map((column) => quote(column.name)).join(", ");

/**
 * A Store table's rows in SQLite, a page at a time, in primary-key order, each as its values in column-name order: to
 * copy, with integers as BigInts, so their type and value come as SQLite holds them; to check, as each value's type
 * and bytes, so text needn't become a JavaScript string, which would hold it twice over.
 */
function sqliteReader(db: Database, schema: string, table: Table, purpose: "copy" | "check") {
  const from = `FROM ${quote(schema)}.${quote(table.name)} ORDER BY ${table.key.map(quote).join(", ")}`;
  const values = purpose === "copy" ? columnList(table) : table.columns.map(({ name }) => `typeof(${quote(name)}), CAST(${quote(name)} AS BLOB)`).join(", ");
  return {
    sizes: () => (db.prepare(`SELECT ${sizeOf(table, (column) => `length(CAST(${column} AS BLOB))`)} ${from}`).pluck().all() as number[]),
    rows: (offset: number, limit: number) => db.prepare(`SELECT ${values} ${from} LIMIT ? OFFSET ?`).raw(true).safeIntegers(purpose === "copy").all(limit, offset) as unknown[][],
  };
}

/** The same in Postgres, whose text keys sort by code point, as SQLite's do. */
function pgReader(sql: PgSql, table: Table) {
  const text = new Set(table.columns.filter((column) => column.type === "text").map((column) => column.name));
  const from = `FROM ${quote(table.name)} ORDER BY ${table.key.map((column) => text.has(column) ? `${quote(column)} COLLATE "C"` : quote(column)).join(", ")}`;
  return {
    sizes: async () => (await sql.all<{ size: number }>(`SELECT ${sizeOf(table, (column) => `octet_length(${column})`)} AS size ${from}`)).map((row) => row.size),
    rows: async (offset: number, limit: number) => (await sql.all<Record<string, unknown>>(`SELECT ${columnList(table)} ${from} LIMIT ? OFFSET ?`, [limit, offset]))
      .map((row) => table.columns.map((column) => row[column.name])),
  };
}

type Hash = ReturnType<typeof createHash>;

/** A row from SQLite's check reader, each value as its type and bytes, into `hash`. */
function hashSqliteRow(hash: Hash, row: unknown[]) {
  for (let i = 0; i < row.length; i += 2) {
    const type = row[i] as string;
    const bytes = row[i + 1] as Buffer | null;
    if (type === "null" || !bytes) {
      hash.update("n;");
    } else if (type === "integer" || type === "real") {
      hash.update(type[0]!);
      hash.update(bytes);
      hash.update(";");
    } else {
      hash.update(`${type[0]}${bytes.length}:`);
      hash.update(bytes);
    }
  }
  hash.update("\n");
}

/** A row from Postgres into `hash`, as hashSqliteRow puts the same row: its integers come as numbers, its text as strings. */
function hashPgRow(hash: Hash, row: unknown[]) {
  for (const value of row) {
    if (value === null) {
      hash.update("n;");
    } else if (typeof value === "number") {
      hash.update(`${Number.isInteger(value) ? "i" : "r"}${value};`);
    } else if (typeof value === "string") {
      hash.update(`t${Buffer.byteLength(value)}:`);
      hash.update(value);
    } else if (Buffer.isBuffer(value)) {
      hash.update(`b${value.length}:`);
      hash.update(value);
    } else {
      throw new Error(`Unexpected value from Postgres: ${typeof value}`);
    }
  }
  hash.update("\n");
}

interface Reader<Sizes, Rows> { sizes(): Sizes; rows(offset: number, limit: number): Rows }

/** Each table's checksum, read a page at a time, letting BB's event loop run between pages. */
async function checksumsOf(
  tables: Table[], signal: AbortSignal,
  reader: (table: Table) => Reader<number[] | Promise<number[]>, unknown[][] | Promise<unknown[][]>>, hashRow: (hash: Hash, row: unknown[]) => void,
) {
  const sums = new Map<string, TableSum>();
  for (const table of tables) {
    stopIfAborted(signal);
    const read = reader(table);
    const hash = createHash("sha256");
    let rows = 0;
    for (const { offset, limit } of pages(await read.sizes(), table.columns.length)) {
      stopIfAborted(signal);
      for (const row of await read.rows(offset, limit)) {
        hashRow(hash, row);
        rows++;
      }
      await nextTurn();
    }
    sums.set(table.name, { rows, sha256: hash.digest("hex") });
  }
  return sums;
}

/**
 * The id SQLite's AUTOINCREMENT gives `table`'s next row: past both its highest id and the highest it ever gave. NaN,
 * which matches nothing, when sqlite_sequence holds it as anything but an integer.
 */
function sqliteNextId(db: Database, schema: string, table: Table & { identity: string }): number {
  const { seq, other } = db.prepare(`SELECT max(seq) AS seq, count(CASE WHEN typeof(seq) <> 'integer' THEN 1 END) AS other FROM ${quote(schema)}.sqlite_sequence WHERE name = ?`)
    .get(table.name) as { seq: number | null; other: number };
  const { id } = db.prepare(`SELECT max(${quote(table.identity)}) AS id FROM ${quote(schema)}.${quote(table.name)}`).get() as { id: number | null };
  return other ? NaN : Math.max(seq ?? 0, id ?? 0) + 1;
}

/** `table`'s identity sequence in Postgres, and the id it gives next. */
async function pgSequence(sql: PgSql, schema: string, table: Table & { identity: string }) {
  const { sequence } = (await sql.get<{ sequence: string }>(`SELECT pg_get_serial_sequence(?, ?) AS sequence`, [`${quote(schema)}.${quote(table.name)}`, table.identity]))!;
  const { last, called } = (await sql.get<{ last: number; called: boolean }>(`SELECT last_value AS last, is_called AS called FROM ${sequence}`))!;
  return { sequence, nextId: called ? last + 1 : last };
}

const withIdentity = (tables: Table[]) => tables.filter((table): table is Table & { identity: string } => table.identity !== null);

/** The checksums of the Store's tables in the SQLite database `schema`. */
export async function sqliteChecksums(db: Database, schema: string, tables: Table[], signal: AbortSignal): Promise<Checksums> {
  return {
    tables: await checksumsOf(tables, signal, (table) => sqliteReader(db, schema, table, "check"), hashSqliteRow),
    nextIds: new Map(withIdentity(tables).map((table) => [table.name, sqliteNextId(db, schema, table)])),
  };
}

/** The checksums of the Store's tables in Postgres schema `schema`. */
export async function pgChecksums(sql: PgSql, schema: string, tables: Table[], signal: AbortSignal): Promise<Checksums> {
  const nextIds = new Map<string, number>();
  for (const table of withIdentity(tables)) nextIds.set(table.name, (await pgSequence(sql, schema, table)).nextId);
  return { tables: await checksumsOf(tables, signal, (table) => pgReader(sql, table), hashPgRow), nextIds };
}

/** The tables, and the next ids, whose checksums differ. */
export function differences(a: Checksums, b: Checksums): string[] {
  const tables = [...new Set([...a.tables.keys(), ...b.tables.keys()])].sort()
    .filter((name) => a.tables.get(name)?.sha256 !== b.tables.get(name)?.sha256 || a.tables.get(name)?.rows !== b.tables.get(name)?.rows);
  const ids = [...new Set([...a.nextIds.keys(), ...b.nextIds.keys()])].sort()
    .filter((name) => a.nextIds.get(name) !== b.nextIds.get(name)).map((name) => `${name}'s next id`);
  return [...tables, ...ids];
}

/** One table copied: its rows, how long it took, and the next id it gives where it has one. */
export interface Copied { table: string; rows: number; ms: number; nextId?: number }

/**
 * Copy the Store's tables from SQLite to Postgres, whose tables are empty, with their ids, and set each identity to
 * give the id SQLite's AUTOINCREMENT would give next. Run inside a Postgres transaction.
 */
export async function copyToPostgres(db: Database, sql: PgSql, schema: string, tables: Table[], signal: AbortSignal, copied: (table: Copied) => void) {
  for (const table of tables) {
    stopIfAborted(signal);
    const started = performance.now();
    const read = sqliteReader(db, "main", table, "copy");
    const row = `(${table.columns.map(() => "?").join(", ")})`;
    let rows = 0;
    for (const { offset, limit } of pages(read.sizes(), table.columns.length)) {
      stopIfAborted(signal);
      const values = read.rows(offset, limit);
      // The value checks keep integers within a JavaScript number's exact range.
      const params = values.flat().map((value) => typeof value === "bigint" ? Number(value) : value as SqlValue);
      await sql.run(`INSERT INTO ${quote(table.name)} (${columnList(table)}) VALUES ${values.map(() => row).join(", ")}`, params);
      rows += values.length;
    }
    let nextId: number | undefined;
    if (table.identity) {
      nextId = sqliteNextId(db, "main", table as Table & { identity: string });
      const { sequence } = await pgSequence(sql, schema, table as Table & { identity: string });
      // A sequence that has never given an id gives its start, 1.
      if (nextId > 1) await sql.get(`SELECT setval(?::regclass, ?, true)`, [sequence, nextId - 1]);
      else await sql.get(`SELECT setval(?::regclass, 1, false)`, [sequence]);
    }
    copied({ table: table.name, rows, ms: Math.round(performance.now() - started), ...nextId === undefined ? {} : { nextId } });
  }
}

/**
 * Replace the rows of the Store's tables in the SQLite database `schema` with Postgres's, with their ids, and record in
 * sqlite_sequence the last id each identity gave, so AUTOINCREMENT gives the id Postgres would give next. Each page is
 * written in a transaction of its own, which nothing else can run inside: run it on a database only this writes to.
 */
export async function copyToSqlite(sql: PgSql, pgSchema: string, db: Database, schema: string, tables: Table[], signal: AbortSignal, copied: (table: Copied) => void) {
  const into = (table: Table) => `${quote(schema)}.${quote(table.name)}`;
  db.transaction(() => {
    for (const table of tables) db.prepare(`DELETE FROM ${into(table)}`).run();
  })();
  for (const table of tables) {
    stopIfAborted(signal);
    const started = performance.now();
    const read = pgReader(sql, table);
    const integer = table.columns.map((column) => column.type !== "text");
    const insert = db.prepare(`INSERT INTO ${into(table)} (${columnList(table)}) VALUES (${table.columns.map(() => "?").join(", ")})`);
    let rows = 0;
    for (const { offset, limit } of pages(await read.sizes(), table.columns.length)) {
      stopIfAborted(signal);
      const values = await read.rows(offset, limit);
      // Integers bound as SQLite integers, as the Store's own writes make them.
      db.transaction(() => {
        for (const row of values) insert.run(...row.map((value, index) => integer[index] && typeof value === "number" ? BigInt(value) : value));
      })();
      rows += values.length;
    }
    let nextId: number | undefined;
    if (table.identity) {
      ({ nextId } = await pgSequence(sql, pgSchema, table as Table & { identity: string }));
      // An integer, as AUTOINCREMENT writes it: sqlite_sequence's seq has no type, so a number would be kept as REAL.
      db.transaction(() => {
        db.prepare(`DELETE FROM ${quote(schema)}.sqlite_sequence WHERE name = ?`).run(table.name);
        db.prepare(`INSERT INTO ${quote(schema)}.sqlite_sequence (name, seq) VALUES (?, ?)`).run(table.name, BigInt(nextId! - 1));
      })();
    }
    copied({ table: table.name, rows, ms: Math.round(performance.now() - started), ...nextId === undefined ? {} : { nextId } });
  }
}
