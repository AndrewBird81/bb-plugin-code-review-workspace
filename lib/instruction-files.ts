// The repo's files that tell agents how to work in it and what to check. The guide writer and the review agent read them
// at the change's base (src/pr-context.ts), so a change can't rewrite its own rules; the Overview says when a change
// edits one.

/** At the repo's root; REVIEW.md, the repo's review rules, only with Read REVIEW.md on. */
export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", "REVIEW.md"];
/** The repo's review rules: at its root, and in a changed file's directory or any above it. */
export const REVIEW_RULES = "REVIEW.md";
/** Scoped instructions: `*.instructions.md` files here whose applyTo globs pick the changed files they cover. */
export const SCOPED_DIR = ".github/instructions";

/** The root files the agents read: without REVIEW.md when `reviewMd` is off. */
export function instructionFiles(reviewMd: boolean): string[] {
  return reviewMd ? INSTRUCTION_FILES : INSTRUCTION_FILES.filter((path) => path !== REVIEW_RULES);
}

/** The changed files the agents read as instructions. Any changed REVIEW.md is read: it sits in a changed file's directory. */
export function changedInstructions(files: readonly string[], reviewMd: boolean): string[] {
  const root = instructionFiles(reviewMd);
  return files.filter((file) => root.includes(file)
    || file.startsWith(`${SCOPED_DIR}/`) && file.endsWith(".instructions.md")
    || reviewMd && file.endsWith(`/${REVIEW_RULES}`));
}
