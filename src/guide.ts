import { z } from "zod";
import { patchRows, splitPatchByFile, type PatchFile } from "./patch";
import { diffPositions } from "./review-positions";
import { hunkErrors } from "./hunks";

export const DiffRefSchema = z.object({
  file: z.string().min(1).describe("The file's exact repo-relative path, as the diff shows it."),
  summary: z.string().min(1).describe("What changed in this file and why it matters, in 1–2 sentences."),
  hunks: z.array(z.number().int().min(1)).min(1).optional().describe("Only for a file split across chapters: the hunks this chapter covers, numbered from 1 in the file's patch order. Leave out to cover the whole file."),
});
export const SectionSchema = z.object({
  id: z.string().min(1).describe("A short kebab-case id, unique in the guide."),
  title: z.string().min(1).describe("The chapter's concept, briefly."),
  overview: z.string().min(1).describe("2–6 sentences of Markdown on what the chapter changes and what to check."),
  risk: z.enum(["low", "medium", "high"]).optional().describe("How closely to read this chapter; see the skill's rubric."),
  focus: z.array(z.string().min(1)).max(3).optional().describe("On medium- and high-risk chapters: 1–3 short things to verify, each starting \"Check that\"."),
  diffs: z.array(DiffRefSchema).min(1).describe("The chapter's files, each in exactly one chapter, or each of a split file's hunks in exactly one chapter."),
});
export const HotspotSchema = z.object({
  file: z.string().min(1).describe("The file's exact repo-relative path, as the diff shows it."),
  line: z.number().int().min(1).describe("A line the diff shows: a new-file line (added or context), or with side LEFT an old-file line."),
  side: z.enum(["LEFT", "RIGHT"]).optional().describe("RIGHT, the default, for a new-file line; LEFT for a removed line, such as a dropped check."),
  why: z.string().min(1).describe("The defect that could hide there, in one sentence."),
});
export const RequirementSchema = z.object({
  text: z.string().min(1).describe("One thing the PR description or a linked ticket asks for, in a short line."),
  status: z.enum(["covered", "partial", "missing", "unclear"]).describe("Whether the diff does it."),
  evidence: z.string().min(1).describe("Why, in one short sentence: what the code does, or what's absent."),
  file: z.string().min(1).optional().describe("Where the diff does it: the file's exact repo-relative path. Required when covered."),
  line: z.number().int().min(1).optional().describe("A line the diff shows in that file: a new-file line, or with side LEFT an old-file line. Required when covered."),
  side: z.enum(["LEFT", "RIGHT"]).optional().describe("RIGHT, the default, for a new-file line; LEFT for a removed line."),
});
export const GuideSchema = z.object({
  title: z.string().min(1).describe("The change, in one line."),
  intent: z.string().min(1).describe("Why the change exists, in 1–2 sentences."),
  sections: z.array(SectionSchema).describe("Chapters, in reading order."),
  unplacedFiles: z.array(z.string()).default([]).describe("Files with nothing to review (binary, mode-only, pure rename): never a file with changed lines. Usually empty."),
  hotspots: z.array(HotspotSchema).max(3).optional().describe("The 1–3 places most likely to hide a defect, highest risk first."),
  requirements: z.array(RequirementSchema).optional().describe("What the PR description and its linked tickets ask for, each checked against the diff. Leave out when the PR doesn't say what it should do."),
  /** What changed since the reviewer's last review, on a re-review. */
  sinceReview: z.string().optional().describe("On a re-review only: what changed since the reviewer's last review, in 2–4 sentences."),
  review: z.object({ gitRef: z.string().min(1), base: z.string().optional() }).optional(),
  source: z.unknown().optional(),
  generator: z.unknown().optional(),
});
function lineErrors(positions: ReturnType<typeof diffPositions>, at: string, file: string, line: number, side: "LEFT" | "RIGHT" = "RIGHT"): string[] {
  const filePositions = positions.get(file);
  if (!filePositions) return [`${at}: ${file} isn't in the diff`];
  if (side === "LEFT") return filePositions.left.has(line) ? [] : [`${at}: line ${line} of ${file} isn't an old-file line the diff shows`];
  return filePositions.right.has(line) ? [] : [`${at}: line ${line} of ${file} isn't a new-file line the diff shows; for a removed line, give side LEFT and its old-file line`];
}

/** Hotspots the reviewer can open: each on a line the diff shows, new-file unless side is LEFT. */
export function checkHotspots(guide: Guide, patch: string): { ok: true } | { ok: false; errors: string[] } {
  const positions = diffPositions(patch);
  const errors = (guide.hotspots ?? []).flatMap(({ file, line, side }, i) => lineErrors(positions, `hotspots.${i}`, file, line, side));
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Requirements the reviewer can check: a covered one opens the line that does it. */
export function checkRequirements(guide: Guide, patch: string): { ok: true } | { ok: false; errors: string[] } {
  const positions = diffPositions(patch);
  const errors = (guide.requirements ?? []).flatMap(({ status, file, line, side }, i) => {
    if (file !== undefined && line !== undefined) return lineErrors(positions, `requirements.${i}`, file, line, side);
    if (file !== undefined || line !== undefined) return [`requirements.${i}: give both file and line, or neither`];
    return status === "covered" ? [`requirements.${i}: a covered requirement needs the file and line that do it`] : [];
  });
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** The id of the review's Overview page (OVERVIEW in lib/workspace-context.tsx), which a chapter's would take over. */
export const OVERVIEW_ID = "overview";

/** A stored guide with a chapter whose id is the Overview page's, as earlier versions accepted, renamed to an id no other chapter has. */
export function renameOverviewChapter(guide: Guide): Guide {
  if (!guide.sections.some((section) => section.id === OVERVIEW_ID)) return guide;
  const ids = new Set(guide.sections.map((section) => section.id));
  let id = "overview-chapter";
  for (let n = 2; ids.has(id); n++) id = `overview-chapter-${n}`;
  return { ...guide, sections: guide.sections.map((section) => section.id === OVERVIEW_ID ? { ...section, id } : section) };
}

// What the guide writer submits is held to more than a stored guide, which earlier versions wrote without these rules.
const SectionInputSchema = SectionSchema.extend({
  id: SectionSchema.shape.id.refine((id) => id !== OVERVIEW_ID, `"${OVERVIEW_ID}" is the Overview page's id; give the chapter another id`)
    .describe(`A short kebab-case id, unique in the guide. Not "${OVERVIEW_ID}", the Overview page's.`),
  title: SectionSchema.shape.title.max(120),
  overview: SectionSchema.shape.overview.max(1_200),
  risk: z.enum(["low", "medium", "high"], { error: "every chapter needs a risk: low, medium, or high" }).describe(SectionSchema.shape.risk.description ?? ""),
  focus: z.array(z.string().min(1).max(200)).max(3).optional().describe("Required on medium- and high-risk chapters: 1–3 short things to verify, each starting \"Check that\"."),
  diffs: z.array(DiffRefSchema.extend({ summary: DiffRefSchema.shape.summary.max(400) })).min(1).describe(SectionSchema.shape.diffs.description ?? ""),
}).superRefine((section, ctx) => {
  if (section.risk !== "low" && !section.focus?.length) ctx.addIssue({ code: "custom", path: ["focus"], message: `a ${section.risk}-risk chapter needs a focus: 1–3 things to check` });
});
const HotspotsInputSchema = z.array(HotspotSchema.extend({ why: HotspotSchema.shape.why.max(300) })).max(3).superRefine((hotspots, ctx) => {
  const seen = new Set<string>();
  for (const [i, { file, line, side }] of hotspots.entries()) {
    const at = `${file}:${line}${side === "LEFT" ? " (LEFT)" : ""}`;
    if (seen.has(at)) ctx.addIssue({ code: "custom", path: [i], message: `${at} is already a hotspot; list each place once` });
    seen.add(at);
  }
});

/** What the guide writer submits; the plugin stamps the rest. */
export const GuideInputSchema = GuideSchema.omit({ review: true, source: true, generator: true }).extend({
  title: GuideSchema.shape.title.max(120),
  intent: GuideSchema.shape.intent.max(800),
  sections: z.array(SectionInputSchema).describe(GuideSchema.shape.sections.description ?? ""),
  hotspots: HotspotsInputSchema.optional().describe(GuideSchema.shape.hotspots.description ?? ""),
  requirements: z.array(RequirementSchema.extend({ text: RequirementSchema.shape.text.max(300), evidence: RequirementSchema.shape.evidence.max(400) })).max(25)
    .optional().describe(GuideSchema.shape.requirements.description ?? ""),
  sinceReview: z.string().max(1_200).optional().describe(GuideSchema.shape.sinceReview.description ?? ""),
});
export type Guide = z.infer<typeof GuideSchema>;

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/** A submitted guide held to GuideInputSchema, without what the plugin stamps; every problem at once. */
export function checkGuideInput(raw: unknown): { ok: true; guide: z.infer<typeof GuideInputSchema> } | { ok: false; errors: string[] } {
  const parsed = GuideInputSchema.safeParse(raw);
  return parsed.success ? { ok: true, guide: parsed.data } : { ok: false, errors: issues(parsed.error) };
}

export function validateGuide(raw: unknown):
  | { ok: true; guide: Guide }
  | { ok: false; errors: string[] } {
  const parsed = GuideSchema.superRefine((guide, ctx) => {
    const seen = new Set<string>();
    for (const [i, section] of guide.sections.entries()) {
      if (seen.has(section.id)) ctx.addIssue({ code: "custom", path: ["sections", i, "id"], message: `duplicate section id ${section.id}` });
      seen.add(section.id);
    }
  }).safeParse(raw);
  if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
  // An empty list means none, as leaving it out does.
  const { hotspots, requirements, ...guide } = parsed.data;
  return { ok: true, guide: {
    ...guide,
    sections: guide.sections.map(({ focus, ...section }) => focus?.length ? { ...section, focus } : section),
    ...(hotspots?.length ? { hotspots } : {}),
    ...(requirements?.length ? { requirements } : {}),
  } };
}

const changedLines = (file: PatchFile) => patchRows(file.text).filter((row) => row.kind === "+" || row.kind === "-").length;

/** Unplaced files the guide may leave out of its chapters: none with changed lines, which a reviewer must read in one. */
export function checkUnplaced(guide: Guide, patch: string): { ok: true } | { ok: false; errors: string[] } {
  const files = new Map(splitPatchByFile(patch).map((file) => [file.path, file]));
  const errors = guide.unplacedFiles.flatMap((path) => {
    const file = files.get(path);
    return file && changedLines(file) ? [`unplaced: ${path} has changed lines; put it in a chapter`] : [];
  });
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Every changed file in exactly one chapter, or each of a split file's hunks in exactly one; `hunks` is each file's hunk count. */
export function checkCoverage(guide: Guide, files: string[], hunks: ReadonlyMap<string, number> = new Map()):
  | { ok: true }
  | { ok: false; errors: string[] } {
  const placed = new Map<string, Array<number[] | undefined>>();
  const place = (file: string, entry?: number[]) => placed.set(file, [...(placed.get(file) ?? []), entry]);
  const errors: string[] = [];
  for (const s of guide.sections) {
    const listed = new Set<string>();
    for (const d of s.diffs) {
      if (listed.has(d.file)) errors.push(`duplicate: ${d.file} is listed twice in ${s.id}; list it once, with all its hunks there`);
      listed.add(d.file);
      place(d.file, d.hunks);
    }
  }
  for (const f of guide.unplacedFiles) place(f);

  const fileSet = new Set(files);
  for (const [file, entries] of placed) {
    if (!fileSet.has(file)) errors.push(`extra: ${file} is in the guide but not in the diff`);
    else errors.push(...hunkErrors(file, entries, hunks.get(file) ?? 0));
  }
  for (const f of files) if (!placed.has(f)) errors.push(`missing: ${f} is in the diff but not in the guide`);
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** What a file's diff does besides changing lines, for a file the guide left unplaced. */
function unplacedSummary(file: PatchFile | undefined): string {
  if (!file) return "Nothing to review in the diff.";
  const rows = patchRows(file.text);
  const header = (prefix: string) => rows.find((row) => row.kind === "header" && row.text.startsWith(prefix))?.text.slice(prefix.length).trim();
  const [oldMode, newMode] = [header("old mode "), header("new mode ")];
  const parts = [
    file.oldPath && `Renamed from \`${file.oldPath}\`.`,
    rows.some((row) => /^Binary files |^GIT binary patch/.test(row.text)) && "Binary file.",
    oldMode && newMode && (newMode === "100755" ? "Made executable." : oldMode === "100755" ? "No longer executable." : `Mode changed from ${oldMode} to ${newMode}.`),
  ].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return header("new file mode") ? "New empty file." : header("deleted file mode") ? "Deleted empty file." : "No content changes.";
}

/** Unplaced files would show nowhere in the workspace, so they become a final chapter. */
export function placeUnplacedFiles(guide: Guide, patch: string): Guide {
  if (!guide.unplacedFiles.length) return guide;
  const files = new Map(splitPatchByFile(patch).map((file) => [file.path, file]));
  const ids = new Set(guide.sections.map((s) => s.id));
  let id = "other-files";
  for (let n = 2; ids.has(id); n++) id = `other-files-${n}`;
  return {
    ...guide,
    sections: [...guide.sections, {
      id, title: "Other files", risk: "low", overview: "Files with nothing to review in the diff, such as binary files, mode changes, or pure renames.",
      diffs: guide.unplacedFiles.map((file) => ({ file, summary: unplacedSummary(files.get(file)) })),
    }],
    unplacedFiles: [],
  };
}
