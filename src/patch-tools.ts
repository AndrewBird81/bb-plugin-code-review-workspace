// The tools that read a review's diff and its changed files, for its own assistant and guide writer only.
import { z } from "zod";
import { changedFiles, splitPatchByFile } from "./patch";
import { continuedFile, describeReviewFiles, offsetPastEnd, PATCH_PAGE_BYTES, patchPage, stubSkippedFiles } from "./review-files";
import { readGeneratedFiles } from "./file-contents";
import { recordAgentReads } from "./agent-reads";
import { runGh, runGit } from "./gh";
import { toolThreadReview } from "./thread-review";
import { focusThread } from "./focus-identity";
import { mergedAway } from "./draft-comments";
import { withPrNote } from "./agent";
import { failed, type ServeDeps } from "./server-modules";

/** A page's size in UTF-8 bytes: PATCH_PAGE_BYTES, or the smaller `limit` asked for, so a page always fits the agent's tool result. */
const pageBytes = (limit?: number) => Math.min(limit ?? PATCH_PAGE_BYTES, PATCH_PAGE_BYTES);

export function register(deps: ServeDeps) {
  const { bb, store } = deps;
  /**
   * Why a thread may not read `targetKey`'s diff: only a review's own assistant or guide writer may, and not once the review
   * was merged into another. Null when it may.
   */
  async function notOwnReview(threadId: string, targetKey: string): Promise<string | null> {
    const own = (await focusThread(bb, store, threadId))?.targetKey ?? await toolThreadReview(bb, store, threadId);
    return own === targetKey ? await mergedAway(store, own) : `This conversation can read only its own review's diff${own ? `, targetKey ${own}` : ""}.`;
  }
  bb.agents.registerTool({
    name: "read_review_patch",
    description: "Return the diff text of your own review, by the targetKey you were given, in pages of about 40 KB that end on file boundaries. A file longer than a page goes on, cut at a line, on the next page, which names it. In pages, lockfiles and generated or vendored files show as one-line stubs. Pass file to read one file's whole diff, in pages of the same size. limit makes a page smaller, never larger.",
    parameters: z.object({
      targetKey: z.string(),
      file: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      // At least one character of any size, so a page always moves on.
      limit: z.number().int().min(4).max(200_000).optional(),
    }),
    async execute({ targetKey, file, offset, limit }, { threadId }) {
      const refused = await notOwnReview(threadId, targetKey);
      if (refused) return failed(refused);
      // Told first, once, if its review became its PR's.
      const noted = <T>(answer: T) => withPrNote(store, threadId, targetKey, answer);
      if (file !== undefined) {
        // The file's diff, and its read recorded, in one turn: a read counts for the diff it read.
        return noted(await store.exclusive(async (tx) => {
          const files = splitPatchByFile(await tx.patch(targetKey));
          // A renamed file is keyed by its new path; its old one finds it too.
          const diff = files.find((f) => f.path === file) ?? files.find((f) => f.oldPath === file);
          if (!diff) return failed(`This review has no diff for ${file}.`);
          const past = offsetPastEnd(`${file}'s diff`, offset ?? 0, diff.text.length);
          if (past) return failed(past);
          await recordAgentReads(tx, threadId, targetKey, [diff.path]);
          const { text, end } = patchPage(diff.text, offset ?? 0, pageBytes(limit));
          return text + (end < diff.text.length ? `\n\n[${end}/${diff.text.length} bytes — call again with file and offset=${end}]` : "");
        }));
      }
      const { patch, review } = await store.exclusive(async (tx) => ({ patch: await tx.patch(targetKey), review: await tx.getReview(targetKey) }));
      const generated = review ? await readGeneratedFiles({ runGh, runGit, bb }, review, changedFiles(patch)) : [];
      // The page, and its read recorded, in one turn.
      return noted(await store.exclusive(async (tx) => {
        const paged = stubSkippedFiles(patch, generated, { lockfileDigest: (await tx.getPreferences()).preferences.knobs.lockfileDigest });
        const past = offsetPastEnd("the diff", offset ?? 0, paged.length);
        if (past) return failed(past);
        const { text, end } = patchPage(paged, offset ?? 0, pageBytes(limit));
        // A page that starts inside a file names it, as its header is on an earlier page.
        const continued = continuedFile(paged, offset ?? 0);
        // Each file the page includes, if only in part.
        await recordAgentReads(tx, threadId, targetKey, [...(continued ? [continued] : []), ...splitPatchByFile(text).map((f) => f.path)]);
        const more = end < paged.length ? `\n\n[${end}/${paged.length} bytes — call again with offset=${end}]` : "";
        return (continued ? `[${continued}'s diff, continued]\n` : "") + text + more;
      }));
    },
  });
  bb.agents.registerTool({
    name: "list_review_files",
    description: "List your own review's changed files, by the targetKey you were given: path, status (added, deleted, modified, \"renamed from ‹path›\" or \"copied from ‹path›\", naming the source), lines added and removed, diff size, and kind (code, test, docs, config, lockfile, generated). A large review's list comes in pages of about 40 KB that end on a file: call again with the offset it gives. offset counts files from 0; limit caps a page's files.",
    parameters: z.object({
      targetKey: z.string(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).optional(),
    }),
    execute: async ({ targetKey, offset, limit }, { threadId }) => {
      const refused = await notOwnReview(threadId, targetKey);
      if (refused) return failed(refused);
      const { patch, review, knobs } = await store.exclusive(async (tx) => ({ patch: await tx.patch(targetKey), review: await tx.getReview(targetKey), knobs: (await tx.getPreferences()).preferences.knobs }));
      const count = splitPatchByFile(patch).length;
      if (offset && offset >= count) return failed(`offset ${offset} is past the end of the list (${count} file${count === 1 ? "" : "s"}).`);
      return describeReviewFiles(patch, review ? await readGeneratedFiles({ runGh, runGit, bb }, review, changedFiles(patch)) : [], { testWeakening: knobs.testWeakening, lockfileDigest: knobs.lockfileDigest }, { offset, limit });
    },
  });
}
