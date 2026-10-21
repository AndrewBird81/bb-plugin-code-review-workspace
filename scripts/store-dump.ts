/**
 * Dump every Store read of a plugin database, and its tables' checksums, to compare the store's behaviour before and
 * after a change (scripts/store-reads.ts). The database is copied first, since some reads write; it is never opened.
 *
 * Run from the repo root: `npx vite-node scripts/store-dump.ts <data.db> <reads.json> <checksums.json>`.
 * `<data.db>` must be a consistent single-file snapshot (VACUUM INTO or the backup API), not a live database with a WAL.
 * The checksums are of the copy's tables before the reads and after them, with the source file's SHA-256. A snapshot
 * from an older release gets the newer migrations when the store opens, stamped with the time, so its `after` checksum
 * of `_bb_migrations` differs from run to run.
 */
import { writeFileSync } from "node:fs";
import { dumpDatabase } from "./store-reads";

// vite-node leaves the script's own path out of argv.
const [source, readsOut, checksumsOut] = process.argv.slice(2);
if (!source || !readsOut || !checksumsOut) {
  process.stderr.write("Usage: npx vite-node scripts/store-dump.ts <data.db> <reads.json> <checksums.json>\n");
  process.exit(2);
}
const { reads, checksums } = await dumpDatabase(source);
writeFileSync(readsOut, reads);
writeFileSync(checksumsOut, checksums);
