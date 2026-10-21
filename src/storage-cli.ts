// bb review storage: where the reviews are kept. It answers whatever state storage is in, maintenance included, where
// the reviews are moved from one backend to the other.
import { STORAGE_OWNER_KEY, type StorageStatus } from "./storage";

export const STORAGE_USAGE = [
  "usage: bb review storage status",
  "",
  "Shows where Code Review Workspace keeps its reviews.",
  "  status  the backend the settings choose (storageBackend), the one holding the reviews (storage:owner), and whether the plugin serves from it",
].join("\n");

type CliResult = { exitCode: number; stdout?: string; stderr?: string };

const STATE: Record<StorageStatus["state"], string> = {
  serving: "serving",
  opening: "opening Postgres; only bb review storage answers until it's open",
  maintenance: "maintenance; only bb review storage answers",
};

/** `bb review storage …`, with `status` what the plugin has found of its storage. */
export function runStorageCommand(status: StorageStatus, argv: string[]): CliResult {
  if (argv.some((arg) => arg === "--help" || arg === "-h")) return { exitCode: 0, stdout: STORAGE_USAGE };
  if (argv.length !== 1 || argv[0] !== "status") return { exitCode: 2, stderr: `${argv.length ? `Unknown storage command: ${argv.join(" ")}` : "Give a storage command."}\n${STORAGE_USAGE}` };
  return { exitCode: 0, stdout: [
    `storageBackend: ${status.configured}`,
    `${STORAGE_OWNER_KEY}: ${status.owner}`,
    `state: ${STATE[status.state]}`,
    ...status.problem ? [`problem: ${status.problem}`] : [],
  ].join("\n") };
}
