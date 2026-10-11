// Shared defaults have no validation/runtime dependencies in the app bundle.

/** A custom agent selection, in bb's terms. Service tiers are provider-defined ids. */
export interface AgentExecution {
  /** The machine the agent runs on; absent runs it on the bb server. */
  hostId?: string;
  providerId: string;
  model: string;
  reasoningLevel: "none" | "low" | "medium" | "high" | "xhigh" | "ultracode" | "max" | "ultra";
  permissionMode: "accept-edits" | "auto" | "full";
  serviceTier?: string;
}

export interface ReviewPreferences {
  guideDetail: "concise" | "standard" | "detailed";
  guideInstructions: string;
  assistantInstructions: string;
  /** The assistant's first message once a review's guide is ready and it has no conversation; blank skips it. */
  automaticReview: string;
  diffLayout: "split" | "unified";
  /** null uses the execution defaults bb remembers for the review's project. */
  guideAgent: AgentExecution | null;
  assistantAgent: AgentExecution | null;
  /** Which author replies on your threads make a review your turn: questions for you, or any reply. */
  wakeOnReplies: "questions" | "any";
  /** After the author pushes, the assistant checks your feedback: never, to show progress, or also to bring the review back when everything is addressed. */
  pushChecks: "off" | "progress" | "ready";
  /** Track PRs you're asked to review or have reviewed on GitHub, not only reviews started in bb. */
  trackGithubReviews: boolean;
  /** Also track requests for a team you're on, not only requests for you. Teams can ask for many reviews. */
  trackTeamRequests: boolean;
  /** Start a guide when your review is requested in these repositories: "owner/repo", "owner/*", or "*". */
  autoStartRepos: string[];
  /** The assistant's first message when a review comes back to you; blank turns the automatic check off. */
  verificationPrompt: string;
  /** Whose PRs agents start on with no click: members and collaborators of the repository, or anyone. Your own PRs and local reviews always. */
  unattendedAuthors: "members" | "anyone";
  /** The review agent may run the repo's documented tests and linters on a trusted author's PR, in a temporary worktree. */
  runRepoChecks: boolean;
}

/** Assistant instructions share bb's 4,096-character instructions with the fixed rules and the guide. */
export const ASSISTANT_INSTRUCTIONS_LIMIT = 2000;

export const defaultPreferences: ReviewPreferences = {
  guideDetail: "standard", guideInstructions: "", assistantInstructions: "",
  automaticReview: [
    "Review this change for defects a careful senior engineer would block on or want fixed. Precision over recall: a missed nit costs nothing; a wrong comment costs the reviewer's trust.",
    "1. Start with read_pr_context: what the PR says it does, linked tickets, the repo's review rules, CI, and what other reviewers already raised.",
    "2. Read the whole diff, high-risk chapters first. Before you comment, confirm the problem with read_file (callers, the base version). If you can't confirm it, don't comment; ask a question only when the answer decides whether there's a bug.",
    "3. Skip style, naming, formatting, anything a linter or CI reports, lockfiles, generated files, and anything an existing GitHub thread already raises.",
    "4. One issue per add_draft_comment, on the line the fix goes. Start with **Blocking:**, **Should fix:** or **Question:**. Say what fails (input → wrong result), then the fix; when the fix replaces specific lines, add a ```suggestion block.",
    "5. At most 10 comments; keep the most severe.",
    "6. Then set_review_summary: 2–5 bullets, blockers first with file:line, and anything you couldn't check. Suggest APPROVE only if nothing blocks and you read every non-generated file, REQUEST_CHANGES only for a verified blocking issue, otherwise COMMENT.",
  ].join("\n"),
  diffLayout: "split", guideAgent: null, assistantAgent: null,
  wakeOnReplies: "questions", pushChecks: "off", trackGithubReviews: true, trackTeamRequests: false, autoStartRepos: [],
  verificationPrompt: "Check whether the author properly addressed each piece of my earlier feedback. Start with list_feedback and read_changes_since_review, and read files with read_file when you need context.\nRecord a verdict with one line of evidence for every item with assess_feedback.\nThen look for new problems the fix commits introduce, and add each as an inline draft comment.\nDraft a reply with draft_thread_reply only on open threads where one adds something: what's still missing, or a short thanks naming the fixing commit. Keep everything terse.",
  unattendedAuthors: "members", runRepoChecks: false,
};
