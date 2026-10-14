// What Finish review asks about before an approval: files in high-risk chapters not viewed, and medium- and high-risk
// chapters marked viewed faster than anyone reads. It informs; Submit anyway still sends.
import type { FileViewFlags } from "../components/DiffViewer";
import { classifyFile } from "../src/classify";
import { chapterReadingLines } from "./review-size";
import type { Chapter } from "./workspace-context";

/** Changed lines an hour past which reviewers find markedly fewer defects (SmartBear's Cisco study: under 500). */
export const MAX_LINES_PER_HOUR = 500;
/** A chapter with fewer lines than this to read isn't judged on its pace: a few minutes either way says little. */
const PACE_MIN_LINES = 50;

export interface ApproveGuard {
  /** Files to read in high-risk chapters that aren't viewed, in reading order. */
  unviewed: string[];
  /** Medium- and high-risk chapters whose files were marked viewed faster than MAX_LINES_PER_HOUR. */
  rushed: Array<{ id: string; number: number; risk: "medium" | "high"; lines: number; minutes: number }>;
}

/**
 * A chapter's reading time runs from the last mark before its first one, in any chapter, to its last mark. With no
 * mark before it, the files marked first have no reading time to measure, so they don't count.
 */
export function approveGuard(sections: readonly Chapter[], views: ReadonlyMap<string, FileViewFlags>, patch: string, lines: ReadonlyMap<string, number>, generated?: ReadonlySet<string>): ApproveGuard {
  const toRead = (file: string) => !classifyFile(file, generated?.has(file)).skippable;
  const markOf = (file: string) => { const view = views.get(file); return view?.viewed ? view.viewedAt : undefined; };
  const marks = [...views.values()].flatMap((view) => view.viewed && view.viewedAt !== undefined ? [view.viewedAt] : []);
  const unviewed = [...new Set(sections.filter((section) => section.risk === "high").flatMap((section) => section.diffs.map((diff) => diff.file)))]
    .filter((file) => toRead(file) && !views.get(file)?.viewed);
  const timed = sections.flatMap((section, index) => {
    if (section.risk !== "medium" && section.risk !== "high") return [];
    const read = section.diffs.filter((diff) => toRead(diff.file) && markOf(diff.file) !== undefined);
    if (!read.length) return [];
    const at = read.map((diff) => markOf(diff.file)!);
    const first = Math.min(...at), last = Math.max(...at);
    const earlier = marks.filter((mark) => mark < first);
    const start = earlier.length ? Math.max(...earlier) : first;
    const counted = earlier.length ? read : read.filter((diff) => markOf(diff.file)! > first);
    return [{ section: { id: section.id, diffs: counted }, number: index + 1, risk: section.risk, ms: last - start }];
  });
  const counts = chapterReadingLines(timed.map(({ section }) => section), patch, lines, generated);
  const rushed = timed.flatMap(({ section, number, risk, ms }) => {
    const count = counts.get(section.id) ?? 0;
    return count >= PACE_MIN_LINES && count > MAX_LINES_PER_HOUR * ms / 3_600_000 ? [{ id: section.id, number, risk, lines: count, minutes: ms / 60_000 }] : [];
  });
  return { unviewed, rushed };
}

/** The doubts in words, as Finish review lists them and Submit asks about them. */
export const unviewedDoubt = (unviewed: readonly string[]) => unviewed.length === 1 ? "1 file in a high-risk chapter not viewed." : `${unviewed.length} files in high-risk chapters not viewed.`;
export const rushedDoubt = ({ number, risk, lines, minutes }: ApproveGuard["rushed"][number]) => `Chapter ${number} (${risk} risk): ${lines} lines marked viewed in ${minutes < 1 ? "under a minute" : `${Math.round(minutes)} min`}.`;
export const approveDoubts = ({ unviewed, rushed }: ApproveGuard) => [...(unviewed.length ? [unviewedDoubt(unviewed)] : []), ...rushed.map(rushedDoubt)];
