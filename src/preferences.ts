import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ASSISTANT_INSTRUCTIONS_LIMIT, defaultPreferences, type AgentExecution, type ReviewPreferences } from "../lib/review-preferences";
export { defaultPreferences, type AgentExecution, type ReviewPreferences } from "../lib/review-preferences";

/** The automatic review's default before the review summary; saved settings that kept it read as the current default. */
export const AUTOMATIC_REVIEW_BEFORE_SUMMARY = "Review this change adversarially. Look up related code or PRs when you need context.\nAdd each finding as an inline draft comment with add_draft_comment. Put general points in your reply.\nKeep every comment terse. Skip nitpicks.";

/** The automatic review's default before it was precision-first; saved settings that kept it read as the current default. */
export const AUTOMATIC_REVIEW_BEFORE_PRECISION = "Review this change adversarially. Look up related code or PRs when you need context.\nAdd each finding as an inline draft comment with add_draft_comment. Then write the review summary with set_review_summary: your overall assessment, what blocks merging, and the verdict you'd suggest. Don't repeat the line comments there.\nKeep every comment terse. Skip nitpicks.";

/** The automatic review's default before it asked for evidence; saved settings that kept it read as the current default. */
export const AUTOMATIC_REVIEW_BEFORE_EVIDENCE = [
  "Review this change for defects a careful senior engineer would block on or want fixed. Precision over recall: a missed nit costs nothing; a wrong comment costs the reviewer's trust.",
  "1. Start with read_pr_context: what the PR says it does, linked tickets, the repo's review rules, CI, and what other reviewers already raised.",
  "2. Read the whole diff, high-risk chapters first. Before you comment, confirm the problem with read_file (callers, the base version). If you can't confirm it, don't comment; ask a question only when the answer decides whether there's a bug.",
  "3. Skip style, naming, formatting, anything a linter or CI reports, lockfiles, generated files, and anything an existing GitHub thread already raises.",
  "4. One issue per add_draft_comment, on the line the fix goes. Start with **Blocking:**, **Should fix:** or **Question:**. Say what fails (input → wrong result), then the fix; when the fix replaces specific lines, add a ```suggestion block.",
  "5. At most 10 comments; keep the most severe.",
  "6. Then set_review_summary: 2–5 bullets, blockers first with file:line, and anything you couldn't check. Suggest APPROVE only if nothing blocks and you read every non-generated file, REQUEST_CHANGES only for a verified blocking issue, otherwise COMMENT.",
].join("\n");

/** The feedback check's default before it replied only on open threads; saved settings that kept it read as the current default. */
export const VERIFICATION_PROMPT_BEFORE_OPEN_THREADS = "Check whether the author properly addressed each piece of my earlier feedback. Start with list_feedback and read_changes_since_review, and read files with read_file when you need context.\nRecord a verdict with one line of evidence for every item with assess_feedback.\nThen look for new problems the fix commits introduce, and add each as an inline draft comment.\nDraft a short reply for each of my threads with draft_thread_reply. Keep everything terse.";

export const agentExecutionSchema = z.object({
  hostId: z.string().min(1).max(200).optional(),
  providerId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]),
  permissionMode: z.enum(["accept-edits", "auto", "full"]),
  serviceTier: z.string().min(1).max(200).optional(),
}).strict();
/** "*", "owner/*", or "owner/repo", as GitHub spells them. */
const REPO_PATTERN = /^(\*|[a-z0-9-]+\/(\*|[a-z0-9_.-]+))$/;

export const agentChoiceSchema = agentExecutionSchema.omit({ permissionMode: true });

export const preferencesSchema = z.object({
  guideDetail: z.enum(["concise", "standard", "detailed"]),
  guideInstructions: z.string().max(12000),
  assistantInstructions: z.string().max(ASSISTANT_INSTRUCTIONS_LIMIT),
  automaticReview: z.string().max(12000),
  diffLayout: z.enum(["split", "unified"]),
  rereviewShows: z.enum(["since", "all"]),
  guideAgent: agentExecutionSchema.nullable(),
  assistantAgent: agentExecutionSchema.nullable(),
  wakeOnReplies: z.enum(["questions", "any"]),
  pushChecks: z.enum(["off", "progress", "ready"]),
  trackGithubReviews: z.boolean(),
  trackTeamRequests: z.boolean(),
  autoStartRepos: z.array(z.string().trim().toLowerCase().regex(REPO_PATTERN, "Use owner/repo, owner/*, or *.")).max(50),
  verificationPrompt: z.string().max(12000),
  unattendedAuthors: z.enum(["members", "anyone"]),
  runRepoChecks: z.boolean(),
  threadListReviews: z.boolean(),
}).strict();

/** Saved settings as they read now: missing fields take their defaults, and older defaults the current ones. */
export function readPreferences(saved: Partial<ReviewPreferences>): ReviewPreferences {
  // Assistant instructions saved before their cap are cut to fit it.
  const preferences = preferencesSchema.parse({ ...defaultPreferences, ...saved, assistantInstructions: (saved.assistantInstructions ?? "").slice(0, ASSISTANT_INSTRUCTIONS_LIMIT) });
  if ([AUTOMATIC_REVIEW_BEFORE_SUMMARY, AUTOMATIC_REVIEW_BEFORE_PRECISION, AUTOMATIC_REVIEW_BEFORE_EVIDENCE].includes(preferences.automaticReview)) preferences.automaticReview = defaultPreferences.automaticReview;
  if (preferences.verificationPrompt === VERIFICATION_PROMPT_BEFORE_OPEN_THREADS) preferences.verificationPrompt = defaultPreferences.verificationPrompt;
  return preferences;
}

export interface PreferencesRecord { preferences: ReviewPreferences; revision: number; }
export interface ReviewerNotesRecord { body: string; revision: number; }

type SpawnExecution = Pick<Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0],
  "providerId" | "model" | "reasoningLevel" | "permissionMode" | "serviceTier" | "executionInputSources">;

/**
 * Spawn fields for an agent selection; none for the project's remembered
 * defaults. Without a permission mode, bb resolves the provider's default.
 */
export function spawnExecution(agent: (Omit<AgentExecution, "permissionMode"> & Partial<Pick<AgentExecution, "permissionMode">>) | null): SpawnExecution {
  if (!agent) return {};
  const explicit = "explicit" as const;
  return {
    providerId: agent.providerId, model: agent.model, reasoningLevel: agent.reasoningLevel,
    ...(agent.permissionMode ? { permissionMode: agent.permissionMode } : {}),
    ...(agent.serviceTier ? { serviceTier: agent.serviceTier } : {}),
    // Unsourced values are replaced with the project's remembered defaults.
    executionInputSources: {
      providerId: explicit, model: explicit, reasoningLevel: explicit,
      ...(agent.permissionMode ? { permissionMode: explicit } : {}),
      ...(agent.serviceTier ? { serviceTier: explicit } : {}),
    },
  };
}

export function guidePreferencesPrompt(preferences: ReviewPreferences): string {
  const detail = {
    concise: "Concise guide: use two short sentences per chapter and brief file summaries.",
    standard: "Standard guide: explain each chapter's change, motivation, and key implications in 2–6 sentences.",
    detailed: "Detailed guide: explain behavioral implications, important contracts, risks, and what deserves a closer read. Use up to six substantive sentences per chapter; keep low-signal changes brief.",
  }[preferences.guideDetail];
  return `${detail}\n${preferences.guideInstructions.trim() ? `Reviewer’s guide instructions:\n${preferences.guideInstructions.trim()}\n` : ""}Keep the required guide schema, exact file coverage, target key, and generation ID unchanged.`;
}

export function assistantPreferencesPrompt(preferences: ReviewPreferences): string {
  return `Current reviewer preferences (replace any earlier preferences):\n${preferences.assistantInstructions.trim().slice(0, ASSISTANT_INSTRUCTIONS_LIMIT) || "Answer concisely, ground claims in the diff, and explain uncertainty. Keep draft comments terse and skip nitpicks."}`;
}

/** Whether a repository ("owner/repo") matches one of the auto-start patterns. */
export function matchesRepo(patterns: readonly string[], repo: string | undefined): boolean {
  if (!repo) return false;
  const name = repo.toLowerCase();
  return patterns.some((pattern) => pattern === "*" || pattern === name || pattern === `${name.split("/")[0]}/*`);
}
