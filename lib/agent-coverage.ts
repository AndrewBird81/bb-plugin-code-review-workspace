// How much of the change the review agent read through Guided Review, for Finish review beside its verdict.
import { classifyFile } from "../src/classify";

export interface AgentCoverage {
  /** Files worth reading that the agent read. */
  read: number;
  /** Files worth reading: not lockfiles or generated files. */
  total: number;
  /** The ones it didn't read, in reading order. */
  unread: string[];
}

/**
 * The agent's reads (src/agent-reads.ts) of `files`, in reading order, leaving out what a reviewer can skip: lockfiles,
 * and generated or vendored files, `generated` being those the repo marks. Reads at another PR head count for nothing.
 */
export function agentCoverage(files: readonly string[], reads: { head: string; files: string[] } | null | undefined, headSha: string | undefined, generated: ReadonlySet<string>): AgentCoverage {
  const read = new Set(reads && (!headSha || reads.head === headSha) ? reads.files : []);
  const worth = [...new Set(files)].filter((file) => !classifyFile(file, generated.has(file)).skippable);
  const unread = worth.filter((file) => !read.has(file));
  return { read: worth.length - unread.length, total: worth.length, unread };
}

/** "12 of 16 files". */
export const readOf = ({ read, total }: AgentCoverage) => `${read} of ${total} file${total === 1 ? "" : "s"}`;
