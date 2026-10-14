import { useId } from "react";
import { KNOB_RANGES, type KnobId, type Knobs } from "../lib/knobs";
import type { ReviewPreferences } from "../lib/review-preferences";
import { Input } from "./ui/input";

type NumberKnob = keyof typeof KNOB_RANGES;
/** Number knobs' text while it isn't a whole number in range; Save waits until it is. */
export type KnobNumberText = Partial<Record<NumberKnob, string>>;

interface KnobControlEntry {
  id: KnobId;
  section: "notifications" | "assistant" | "turn" | "reading" | "comments" | "trust";
  label: string;
  description: string;
  /** A dependent, indented and disabled while this is false. */
  enabledWhen?: (preferences: ReviewPreferences) => boolean;
  /** A number's unit, after its input. */
  unit?: string;
}

/** Every knob's control, in page order. */
export const KNOB_CONTROLS: readonly KnobControlEntry[] = [
  { id: "alertGuides", section: "notifications", label: "A guide is ready or failed", description: "Needs You alerts you when a guide is built, or couldn’t be." },
  { id: "alertTurns", section: "notifications", label: "A review becomes your turn", description: "Re-requested, a request for your review, a question or mention, your feedback handled, or a snooze ending." },
  { id: "runAutomaticReview", section: "assistant", label: "Run the automatic review", description: "When a guide is ready and the review has no conversation yet, the assistant reviews the change with the prompt below. Off keeps the prompt for later." },
  { id: "recheckOnNewCommits", section: "assistant", label: "Re-check the agent’s comments after new commits", description: "When a guide updates for new commits, the assistant checks the comments it drafted and removes the ones the commits fixed." },
  { id: "mentionsWake", section: "turn", label: "Come back when you’re mentioned", description: "A mention of you on the PR, in a review, or in a line comment brings the review back. Off, mentions don’t." },
  { id: "prepareOnReturn", section: "turn", label: "Get a review ready before alerting you", description: "When a review comes back, rebuild an out-of-date guide and run the re-review check first, for up to 10 minutes. Off, the alert comes at once, and Update guide and Check again are a click away." },
  { id: "runReReviewCheck", section: "turn", label: "Run the re-review check", description: "The assistant checks your earlier feedback: when a review comes back (with Get a review ready on), after pushes as set below, and when you click Check again. Off keeps the prompt for later." },
  { id: "trackReviewedPrs", section: "turn", label: "Include PRs you’ve reviewed", description: "Open PRs you reviewed on GitHub in the last 60 days, not only requests for you.", enabledWhen: (preferences) => preferences.trackGithubReviews },
  { id: "returnToOverview", section: "reading", label: "Open on the Overview when a review comes back", description: "A review that comes back to you opens on its Overview, with Comments on what needs you. Off, it reopens where you left it." },
  { id: "singleKeyShortcuts", section: "reading", label: "Single-key shortcuts", description: "Keys like j, c, and s work anywhere in a review, and / finds a review in All reviews. Turn them off if you use speech input or press keys by accident. Esc still closes what’s over the code." },
  { id: "foldViewedFiles", section: "reading", label: "Fold files you’ve viewed", description: "Marking a file viewed folds it. Off, it stays open." },
  { id: "foldGeneratedFiles", section: "reading", label: "Fold lockfiles and generated files", description: "They start folded, with Show diff. Off, they open like any other file." },
  { id: "requirements", section: "reading", label: "Requirements", description: "What the PR and its linked tickets ask for, and whether the diff does it, on the Overview. The assistant still checks them." },
  { id: "codeOwners", section: "reading", label: "Code owners", description: "Owned by on each file, with yours marked, from CODEOWNERS. The assistant still knows which files are yours." },
  { id: "ciInCode", section: "reading", label: "CI failures in the code", description: "Failing checks’ annotations under their lines. The Overview lists failing checks either way." },
  { id: "askAboutSelection", section: "comments", label: "Ask agent about selected text", description: "Selecting text in the code offers Ask agent about selection. Off, it only selects the text; selected lines still offer Comment and Ask agent." },
  { id: "approveGuard", section: "comments", label: "Check before you approve", description: "With Approve picked, Finish review flags unviewed files in high-risk chapters, and chapters marked viewed faster than anyone reads, and Submit asks once more." },
  { id: "approveGuardPace", section: "comments", label: "Flag chapters read faster than", unit: "lines an hour", description: "Medium- and high-risk chapters of 50 lines or more, marked viewed faster than this.", enabledWhen: (preferences) => preferences.knobs.approveGuard },
  { id: "unattendedAgents", section: "trust", label: "Start agents on their own", description: "Guides, the automatic review, and re-review checks start without your click on PRs from the authors below. Off, other people’s PRs wait for your click. Your own PRs and local reviews always run, unless the PR’s branch is in someone else’s fork." },
];

/** A whole number in the knob's range, or null. */
function readNumber(id: NumberKnob, text: string): number | null {
  const { min, max } = KNOB_RANGES[id];
  const value = /^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN;
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** One knob's control: a checkbox row, or a number in a sentence. A dependent indents, and is disabled while its parent is off. */
export function KnobControl({ id, record, onChange, numberText, onNumberText }: {
  id: KnobId; record: ReviewPreferences; onChange<K extends KnobId>(id: K, value: Knobs[K]): void;
  numberText: KnobNumberText; onNumberText(id: NumberKnob, text: string | undefined): void;
}) {
  const control = KNOB_CONTROLS.find((entry) => entry.id === id)!;
  const enabled = control.enabledWhen?.(record) ?? true;
  const ids = useId();
  const value = record.knobs[id];
  if (typeof value === "number") {
    const numberId = id as NumberKnob;
    const { min, max } = KNOB_RANGES[numberId];
    const text = numberText[numberId];
    return <div className={`space-y-1 ${control.enabledWhen ? "ml-6" : ""}`}>
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span id={`${ids}-label`}>{control.label}</span>
        <Input type="number" inputMode="numeric" min={min} max={max} className="h-8 w-20 tabular-nums" disabled={!enabled}
          aria-labelledby={`${ids}-label ${ids}-unit`} aria-describedby={`${ids}-description ${ids}-error`} aria-invalid={text !== undefined}
          value={text ?? String(value)}
          onChange={(event) => {
            const next = readNumber(numberId, event.target.value);
            if (next === null) onNumberText(numberId, event.target.value);
            else { onNumberText(numberId, undefined); onChange(numberId, next); }
          }} />
        <span id={`${ids}-unit`}>{control.unit}</span>
      </p>
      <span id={`${ids}-description`} className="block text-xs text-muted-foreground">{control.description}</span>
      <span id={`${ids}-error`} className="block text-xs text-destructive-text">{text !== undefined ? `Use a whole number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}.` : ""}</span>
    </div>;
  }
  return <label className={`flex items-start gap-2.5 ${control.enabledWhen ? "ml-6" : ""}`}>
    <input type="checkbox" className="mt-0.5 size-4 accent-primary" disabled={!enabled} checked={value} onChange={(event) => onChange(id, event.target.checked)} />
    <span className="space-y-1"><span className="block text-sm font-medium">{control.label}</span><span className="block text-xs text-muted-foreground">{control.description}</span></span>
  </label>;
}
