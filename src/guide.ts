import { z } from "zod";

export const DiffRefSchema = z.object({
  file: z.string().min(1).describe("The file's exact repo-relative path, as the diff shows it."),
  summary: z.string().min(1).describe("What changed in this file and why it matters, in 1–2 sentences."),
});
export const SectionSchema = z.object({
  id: z.string().min(1).describe("A short kebab-case id, unique in the guide."),
  title: z.string().min(1).describe("The chapter's concept, briefly."),
  overview: z.string().min(1).describe("2–6 sentences of Markdown on what the chapter changes and what to check."),
  risk: z.enum(["low", "medium", "high"]).optional().describe("How closely to read this chapter; see the skill's rubric."),
  diffs: z.array(DiffRefSchema).min(1).describe("The chapter's files, each in exactly one chapter."),
});
export const GuideSchema = z.object({
  title: z.string().min(1).describe("The change, in one line."),
  intent: z.string().min(1).describe("Why the change exists, in 1–2 sentences."),
  sections: z.array(SectionSchema).describe("Chapters, in reading order."),
  unplacedFiles: z.array(z.string()).default([]).describe("Files with nothing to review (binary, mode-only, pure rename). Usually empty."),
  /** What changed since the reviewer's last review, on a re-review. */
  sinceReview: z.string().optional().describe("On a re-review only: what changed since the reviewer's last review, in 2–4 sentences."),
  review: z.object({ gitRef: z.string().min(1), base: z.string().optional() }).optional(),
  source: z.unknown().optional(),
  generator: z.unknown().optional(),
});
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

/** Unplaced files would show nowhere in the workspace, so they become a final chapter. */
export function placeUnplacedFiles(guide: Guide): Guide {
  if (!guide.unplacedFiles.length) return guide;
  const ids = new Set(guide.sections.map((s) => s.id));
  let id = "other-files";
  for (let n = 2; ids.has(id); n++) id = `other-files-${n}`;
  return {
    ...guide,
    sections: [...guide.sections, {
      id, title: "Other files", risk: "low", overview: "Files with nothing to review in the diff, such as binary files, mode changes, or pure renames.",
      diffs: guide.unplacedFiles.map((file) => ({ file, summary: "Nothing to review in the diff." })),
    }],
    unplacedFiles: [],
  };
}
