// The guide writer's tool that submits the guide: checked whole, and saved only for the generation still current.
import { z } from "zod";
import { changedFiles } from "./patch";
import { validateGuide, checkCoverage, checkGuideInput, checkHotspots, checkRequirements, checkUnplaced, GuideInputSchema, placeUnplacedFiles } from "./guide";
import { hunkCounts } from "./hunks";
import { guideAccepted, guideAsksSinceReview, guideRejected, guideStopped } from "./generate";
import { failed, type ServeDeps } from "./server-modules";

export function register(deps: ServeDeps) {
  const { bb, store } = deps;
  const guideToolParameters = z.object({ targetKey: z.string(), generationId: z.string(), guide: GuideInputSchema });
  bb.agents.registerTool({
    name: "generate_review_guide",
    description: "Submit the guide. It's rejected, with every problem listed, unless: each changed file (or each hunk of a split file) is in exactly one chapter; chapter ids are unique, and none is \"overview\", the Overview page's; unplaced files have no changed lines; every chapter has a risk, and medium- and high-risk chapters a focus; no hotspot is listed twice; each hotspot and covered requirement points at a line the diff shows, a new-file line or, with side LEFT, a removed line's old-file line; and its text fits the schema's length limits. Fix and resubmit with the same targetKey and generationId.",
    instructions: "When generate_review_guide answers `Guide accepted.`, stop.",
    // A JSON schema, not zod, so the guide's rules are checked here, with its coverage, and every error comes back at once.
    parameters: z.toJSONSchema(guideToolParameters, { io: "input" }),
    async execute(raw) {
      const ids = guideToolParameters.pick({ targetKey: true, generationId: true }).safeParse(raw);
      if (!ids.success) return failed("Pass targetKey and generationId exactly as your task gives them.");
      const { targetKey, generationId } = ids.data;
      // Fenced: the generation is checked, and its guide saved, in one turn, so a generation begun meanwhile comes after both.
      return store.exclusive(async (tx) => {
        if (!await tx.isCurrentGeneration(targetKey, generationId) || (await tx.getReview(targetKey))?.status !== "generating") {
          return failed("This generation was superseded or interrupted. Do not overwrite the current review.");
        }
        // Stopped, it's finalizing: a guide now would stand in for the one you stopped.
        if (guideStopped(bb, generationId)) return failed("The reviewer stopped this guide. Don't submit it again.");
        // The run remembers why, to remind its worker and tell the reviewer if the guide fails.
        const reject = (text: string) => { guideRejected(bb, generationId, text); return failed(text); };
        const guide = (raw as { guide?: unknown }).guide;
        const input = checkGuideInput(guide);
        // The input's parse drops what the plugin stamps; a guide that fails it is never saved.
        const v = validateGuide(input.ok ? input.guide : guide);
        const invalid = [...new Set([...(input.ok ? [] : input.errors), ...(v.ok ? [] : v.errors)])];
        if (!v.ok) return reject("Invalid guide:\n" + invalid.join("\n"));
        const patch = await tx.patch(targetKey);
        const files = changedFiles(patch);
        // Every category's errors in one answer, so one more call can fix them all.
        const errors = [...(invalid.length ? [`Invalid guide:\n${invalid.join("\n")}`] : []), ...([
          ["Coverage errors", [checkCoverage(v.guide, files, hunkCounts(patch)), checkUnplaced(v.guide, patch)]],
          ["Hotspot errors", [checkHotspots(v.guide, patch)]],
          ["Requirement errors", [checkRequirements(v.guide, patch)]],
        ] as const).flatMap(([heading, checks]) => {
          const found = checks.flatMap((check) => check.ok ? [] : check.errors);
          return found.length ? [`${heading}:\n${found.join("\n")}`] : [];
        })];
        if (errors.length) return reject(errors.join("\n\n"));
        // Stamp the store's authoritative gitRef/base over whatever the agent
        // submitted — the guide must never carry a wrong or stale review ref.
        const meta = await tx.getReview(targetKey);
        if (meta?.gitRef) v.guide.review = { gitRef: meta.gitRef, ...(meta.base ? { base: meta.base } : {}) };
        // Only a re-review is asked what changed since your review; a first guide's would show as if you had reviewed it.
        if (!guideAsksSinceReview(bb, generationId)) delete v.guide.sinceReview;
        await tx.saveGuide(targetKey, placeUnplacedFiles(v.guide, patch));
        guideAccepted(bb, generationId);
        return "Guide accepted.";
      });
    },
  });
}
