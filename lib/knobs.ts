// Switches, and one number, that turn the plugin's features off or tune them: each default is 0.6.0's behavior.

/** Settings → Guide generation, Reading, Comments and Finish review, Review agent, Whose turn, Notifications, and Trust. */
export interface Knobs {
  singleKeyShortcuts: boolean; returnToOverview: boolean; foldViewedFiles: boolean; foldGeneratedFiles: boolean;
  localDiffChanges: boolean; sendToThread: boolean; openInEditor: boolean; reviewCommandInThreads: boolean;
  requirements: boolean; codeOwners: boolean; ciInCode: boolean;
  commentKeys: boolean; removalReasons: boolean; moveToSummary: boolean;
  askAboutSelection: boolean; approveGuard: boolean;
  /** Changed lines an hour past which a chapter counts as read too fast. */
  approveGuardPace: number;
  preExistingFindings: boolean; agentCoverage: boolean; testWeakening: boolean; lockfileDigest: boolean;
  runAutomaticReview: boolean; recheckOnNewCommits: boolean;
  digDeeper: boolean; checkFailureActions: boolean;
  stopGenerating: boolean;
  mentionsWake: boolean; prepareOnReturn: boolean; runReReviewCheck: boolean; trackReviewedPrs: boolean;
  alertGuides: boolean; alertTurns: boolean;
  reviewMd: boolean; paletteCommands: boolean;
  unattendedAgents: boolean;
  reviewAgentActs: boolean; reviewChangesLine: boolean; trackOwnPrs: boolean;
}
export type KnobId = keyof Knobs;

/** Every toggle on; the pace is lib/approve-guard.ts's MAX_LINES_PER_HOUR. */
export const defaultKnobs: Knobs = {
  singleKeyShortcuts: true, returnToOverview: true, foldViewedFiles: true, foldGeneratedFiles: true,
  localDiffChanges: true, sendToThread: true, openInEditor: true, reviewCommandInThreads: true,
  requirements: true, codeOwners: true, ciInCode: true,
  commentKeys: true, removalReasons: true, moveToSummary: true,
  askAboutSelection: true, approveGuard: true, approveGuardPace: 500,
  preExistingFindings: true, agentCoverage: true, testWeakening: true, lockfileDigest: true,
  runAutomaticReview: true, recheckOnNewCommits: true,
  digDeeper: true, checkFailureActions: true,
  stopGenerating: true,
  mentionsWake: true, prepareOnReturn: true, runReReviewCheck: true, trackReviewedPrs: true,
  alertGuides: true, alertTurns: true,
  reviewMd: true, paletteCommands: true,
  unattendedAgents: true,
  reviewAgentActs: true, reviewChangesLine: true, trackOwnPrs: true,
};

/** The number knobs' whole-number ranges. */
export const KNOB_RANGES = { approveGuardPace: { min: 100, max: 2000 } } as const;
