// What Finish review asks about before an approval: files in high-risk chapters and flagged files not viewed, which Submit
// asks about once more, and medium- and high-risk chapters marked viewed faster than they read, which it lists, as each
// such chapter does. It informs; Submit anyway still sends.
import type { FileViewFlags } from "../components/DiffViewer";
import { classifyFile } from "../src/classify";
import { filePart } from "../src/hunks";
import { splitPatchByFile } from "../src/patch";
import { hasHiddenBidi } from "./hidden-bidi";
import { lockfileDigest } from "./lockfile-digest";
import { changedLines } from "./review-size";
import { testWeakening } from "./test-weakening";
import type { Chapter } from "./workspace-context";

/** Changed lines an hour past which reviewers find markedly fewer defects (SmartBear's Cisco study: under 500): code's. */
export const MAX_LINES_PER_HOUR = 500;
/** Tests and docs, which reviewers rightly read faster. */
export const SKIM_LINES_PER_HOUR = 2000;
/** A chapter that takes less than this at its paces isn't judged on them: a few minutes either way says little. */
const PACE_MIN_MS = 6 * 60_000;

/** Lines an hour each kind of file reads at: Settings → Check before you approve. Lockfiles and generated files never count. */
export interface ReadingPace { code: number; tests: number; docs: number }
export const DEFAULT_PACE: ReadingPace = { code: MAX_LINES_PER_HOUR, tests: SKIM_LINES_PER_HOUR, docs: SKIM_LINES_PER_HOUR };

/** What flags a file, as its header says: tests it weakens, a lockfile's new download host, hidden bidirectional Unicode. */
export type FileFlag = "weakened" | "host" | "bidi";

/** A chapter read faster than its paces. `focus`: its first "Check that…". */
export interface QuickRead { id: string; number: number; risk: "medium" | "high"; lines: number; minutes: number; focus?: string }

export interface ApproveGuard {
  /** Files to read in high-risk chapters that aren't viewed, in reading order. */
  unviewed: string[];
  /** Flagged files that aren't viewed, in reading order. */
  flagged: Array<{ file: string; flags: FileFlag[] }>;
  /** Medium- and high-risk chapters, every file to read in them viewed, read faster than Settings' paces. */
  rushed: QuickRead[];
}

export interface GuardOptions {
  /** Files the repo marks generated. */
  generated?: ReadonlySet<string>;
  /** Files the change put at their paths, which their paths don't make generated. */
  chosen?: ReadonlySet<string>;
  pace?: ReadingPace;
  /** How long each chapter showed in a window in view (lib/chapter-reads.ts). */
  opened?: ReadonlyMap<string, number>;
  /** When you said each chapter's quick read was fine. */
  fine?: ReadonlyMap<string, number>;
  /** Each flagged file's flags (fileFlags). */
  flags?: ReadonlyMap<string, FileFlag[]>;
}

/**
 * A chapter is judged once every file to read in it is viewed. Its reading time runs from the last mark before its first
 * one, in any chapter, to its last mark, or is how long it showed in view, whichever is longer. With no mark before it,
 * the files marked first have no reading time to measure, so they don't count. One you said was fine since its last mark
 * isn't listed.
 */
export function approveGuard(sections: readonly Chapter[], views: ReadonlyMap<string, FileViewFlags>, patch: string, lines: ReadonlyMap<string, number>, { generated, chosen, pace = DEFAULT_PACE, opened, fine, flags }: GuardOptions = {}): ApproveGuard {
  const kind = (file: string) => classifyFile(file, generated?.has(file), chosen?.has(file));
  const toRead = (file: string) => !kind(file).skippable;
  const markOf = (file: string) => { const view = views.get(file); return view?.viewed ? view.viewedAt : undefined; };
  const marks = [...views.values()].flatMap((view) => view.viewed && view.viewedAt !== undefined ? [view.viewedAt] : []);
  const files = [...new Set(sections.flatMap((section) => section.diffs.map((diff) => diff.file)))];
  const unviewed = [...new Set(sections.filter((section) => section.risk === "high").flatMap((section) => section.diffs.map((diff) => diff.file)))]
    .filter((file) => toRead(file) && !views.get(file)?.viewed);
  const flagged = files.flatMap((file) => { const found = flags?.get(file); return found?.length && !views.get(file)?.viewed ? [{ file, flags: found }] : []; });
  // A file split across chapters reads in each only its hunks there.
  const texts = new Map(splitPatchByFile(patch).map((file) => [file.path, file.text]));
  const linesIn = ({ file, hunks }: Chapter["diffs"][number]) => hunks && texts.has(file) ? changedLines(filePart(texts.get(file)!, hunks)).get(file) ?? 0 : lines.get(file) ?? 0;
  const paceOf = (file: string) => { const { category } = kind(file); return category === "test" ? pace.tests : category === "docs" ? pace.docs : pace.code; };
  const rushed = sections.flatMap((section, index): QuickRead[] => {
    if (section.risk !== "medium" && section.risk !== "high") return [];
    const read = section.diffs.filter((diff) => toRead(diff.file));
    if (!read.length || read.some((diff) => markOf(diff.file) === undefined)) return [];
    const at = read.map((diff) => markOf(diff.file)!);
    const first = Math.min(...at), last = Math.max(...at);
    if ((fine?.get(section.id) ?? -Infinity) >= last) return [];
    const earlier = marks.filter((mark) => mark < first);
    const counted = earlier.length ? read : read.filter((diff) => markOf(diff.file)! > first);
    const ms = Math.max(last - (earlier.length ? Math.max(...earlier) : first), opened?.get(section.id) ?? 0);
    const needed = counted.reduce((sum, diff) => sum + linesIn(diff) / paceOf(diff.file), 0) * 3_600_000;
    if (needed < PACE_MIN_MS || needed <= ms) return [];
    const count = counted.reduce((sum, diff) => sum + linesIn(diff), 0);
    return [{ id: section.id, number: index + 1, risk: section.risk, lines: count, minutes: ms / 60_000, ...section.focus?.[0] ? { focus: section.focus[0] } : {} }];
  });
  return { unviewed, flagged, rushed };
}

/** Each flagged file's flags, as its header shows them: weakened tests and lockfiles' new hosts only while Settings shows those. */
export function fileFlags(patch: string, { generated, chosen, weakTests = true, lockfiles = true }: { generated?: ReadonlySet<string>; chosen?: ReadonlySet<string>; weakTests?: boolean; lockfiles?: boolean } = {}): Map<string, FileFlag[]> {
  return new Map(splitPatchByFile(patch).flatMap(({ path, text }) => {
    const flags: FileFlag[] = [];
    if (weakTests && testWeakening(path, text, generated?.has(path), chosen?.has(path))) flags.push("weakened");
    if (lockfiles && lockfileDigest(path, text)?.hosts.length) flags.push("host");
    if (hasHiddenBidi(path, text)) flags.push("bidi");
    return flags.length ? [[path, flags] as const] : [];
  }));
}

/** The doubts in words, as Finish review lists them and Submit asks about them. */
export const unviewedDoubt = (unviewed: readonly string[]) => unviewed.length === 1 ? "1 file in a high-risk chapter not viewed." : `${unviewed.length} files in high-risk chapters not viewed.`;
const FLAGS: ReadonlyArray<[FileFlag, string]> = [["weakened", "tests weakened"], ["host", "a new download host"], ["bidi", "hidden Unicode"]];
export const flaggedDoubt = (flagged: ApproveGuard["flagged"]) =>
  `${flagged.length === 1 ? "1 flagged file" : `${flagged.length} flagged files`} not viewed: ${FLAGS.filter(([flag]) => flagged.some((file) => file.flags.includes(flag))).map(([, words]) => words).join(", ")}.`;
/** What Submit asks about once more: files you haven't viewed. Chapters read quickly it doesn't. */
export const approveDoubts = ({ unviewed, flagged }: ApproveGuard) => [...(unviewed.length ? [unviewedDoubt(unviewed)] : []), ...(flagged.length ? [flaggedDoubt(flagged)] : [])];

const took = (minutes: number) => minutes < 1 ? "under a minute" : `${Math.round(minutes)} min`;
const chapters = (rushed: readonly QuickRead[]) => {
  const numbers = rushed.map((chapter) => chapter.number);
  return numbers.length === 1 ? `chapter ${numbers[0]}` : `chapters ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
};
/** On its chapter: "Read quickly · 237 lines in 1 min". */
export const quickNote = ({ lines, minutes }: QuickRead) => `Read quickly · ${lines.toLocaleString()} lines in ${took(minutes)}`;
/** Finish review's row: "Read quickly: chapters 2 and 3 · 373 lines in 2 min". */
export const quickRead = (rushed: readonly QuickRead[]) =>
  `Read quickly: ${chapters(rushed)} · ${rushed.reduce((sum, chapter) => sum + chapter.lines, 0).toLocaleString()} lines in ${took(rushed.reduce((sum, chapter) => sum + chapter.minutes, 0))}`;
/** As you mark it viewed: "Chapter 3 went quickly for high risk." */
export const quickToast = (rushed: readonly QuickRead[]) => rushed.length === 1
  ? `Chapter ${rushed[0].number} went quickly for ${rushed[0].risk} risk.`
  : `${chapters(rushed).replace(/^c/, "C")} went quickly for their risk.`;
/** The one to go back to: the highest risk, then the most lines. */
export const riskiest = (rushed: readonly QuickRead[]) => [...rushed].sort((a, b) => Number(b.risk === "high") - Number(a.risk === "high") || b.lines - a.lines)[0];
