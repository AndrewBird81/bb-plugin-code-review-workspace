import { z } from "zod";
import { patchRows, splitPatchByFile, type PatchFile } from "./patch";
import { diffPositions } from "./review-positions";

export const DiffRefSchema = z.object({
  file: z.string().min(1).describe("The file's exact repo-relative path, as the diff shows it."),
  summary: z.string().min(1).describe("What changed in this file and why it matters, in 1–2 sentences."),
});
export const SectionSchema = z.object({
  id: z.string().min(1).describe("A short kebab-case id, unique in the guide."),
  title: z.string().min(1).describe("The chapter's concept, briefly."),
  overview: z.string().min(1).describe("2–6 sentences of Markdown on what the chapter changes and what to check."),
  risk: z.enum(["low", "medium", "high"]).optional().describe("How closely to read this chapter; see the skill's rubric."),
  focus: z.array(z.string().min(1)).min(1).max(3).optional().describe("On medium- and high-risk chapters: 1–3 short things to verify, each starting \"Check that\"."),
  diffs: z.array(DiffRefSchema).min(1).describe("The chapter's files, each in exactly one chapter."),
});
export const HotspotSchema = z.object({
  file: z.string().min(1).describe("The file's exact repo-relative path, as the diff shows it."),
  line: z.number().int().min(1).describe("A new-file line the diff shows: added or context."),
  why: z.string().min(1).describe("The defect that could hide there, in one sentence."),
});
export const GuideSchema = z.object({
  title: z.string().min(1).describe("The change, in one line."),
  intent: z.string().min(1).describe("Why the change exists, in 1–2 sentences."),
  sections: z.array(SectionSchema).describe("Chapters, in reading order."),
  unplacedFiles: z.array(z.string()).default([]).describe("Files with nothing to review (binary, mode-only, pure rename). Usually empty."),
  hotspots: z.array(HotspotSchema).min(1).max(3).optional().describe("The 1–3 places most likely to hide a defect, highest risk first."),
  /** What changed since the reviewer's last review, on a re-review. */
  sinceReview: z.string().optional().describe("On a re-review only: what changed since the reviewer's last review, in 2–4 sentences."),
  review: z.object({ gitRef: z.string().min(1), base: z.string().optional() }).optional(),
  source: z.unknown().optional(),
  generator: z.unknown().optional(),
});
/** Hotspots the reviewer can open: each on a new-file line the diff shows. */
export function checkHotspots(guide: Guide, patch: string): { ok: true } | { ok: false; errors: string[] } {
  const positions = diffPositions(patch);
  const errors = (guide.hotspots ?? []).flatMap(({ file, line }, i) => {
    const lines = positions.get(file)?.right;
    if (!lines) return [`hotspots.${i}: ${file} isn't in the diff`];
    return lines.has(line) ? [] : [`hotspots.${i}: line ${line} of ${file} isn't a new-file line the diff shows`];
  });
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** What the guide writer submits; the plugin stamps the rest. */
export const GuideInputSchema = GuideSchema.omit({ review: true, source: true, generator: true });
export type Guide = z.infer<typeof GuideSchema>;

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
  if (parsed.success) return { ok: true, guide: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

export function checkCoverage(guide: Guide, files: string[]):
  | { ok: true }
  | { ok: false; errors: string[] } {
  const placed = new Map<string, number>();
  for (const s of guide.sections) for (const d of s.diffs) placed.set(d.file, (placed.get(d.file) ?? 0) + 1);
  for (const f of guide.unplacedFiles) placed.set(f, (placed.get(f) ?? 0) + 1);

  const errors: string[] = [];
  const fileSet = new Set(files);
  for (const [file, count] of placed) {
    if (!fileSet.has(file)) errors.push(`extra: ${file} is in the guide but not in the diff`);
    else if (count > 1) errors.push(`duplicate: ${file} appears ${count} times`);
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
  const changed = rows.filter((row) => row.kind === "+" || row.kind === "-").length;
  const parts = [
    file.oldPath && `Renamed from \`${file.oldPath}\`.`,
    rows.some((row) => /^Binary files |^GIT binary patch/.test(row.text)) && "Binary file.",
    oldMode && newMode && (newMode === "100755" ? "Made executable." : oldMode === "100755" ? "No longer executable." : `Mode changed from ${oldMode} to ${newMode}.`),
    changed > 0 && `${changed} changed line${changed === 1 ? "" : "s"}.`,
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
