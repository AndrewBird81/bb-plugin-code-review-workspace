import { memo, type ReactNode } from "react";
import { classifyFile } from "../src/classify";
import { cn } from "../lib/utils";
import { useWorkspace } from "../lib/workspace-context";
import { RISK_LABEL, RISK_TONE } from "./ChapterNav";
import { ReviewHeader } from "./ReviewHeader";
import { StartHere } from "./StartHere";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { InlineCode } from "./ui/inline-code";

type ChecksSummary = { bucket: string; checks: any[] } | null;

/**
 * The review's first page, before its chapters: what the PR is and why, where it stands, what to read first, what it
 * asks for, and its chapters, with the way into them.
 */
export const ReviewOverview = memo(function ReviewOverview({ checks, readLines, changedSince, generated, snoozing, resume, trailing, onShowFeedback, onOpenLine }: {
  checks: ChecksSummary;
  /** The changed lines worth reading (lib/review-size.ts readingLines). */
  readLines: number;
  /** Per chapter id, how many of its files changed since your review. */
  changedSince?: Record<string, number>;
  /** Files the repo's .gitattributes marks generated or vendored. */
  generated?: ReadonlySet<string>;
  snoozing: boolean;
  /** The chapter you were reading, to continue from. */
  resume?: string;
  /** Actions at the end of the title row. */
  trailing?: ReactNode;
  /** Your feedback's progress opens it in Comments. */
  onShowFeedback?: () => void;
  onOpenLine: (file: string, line: number) => void;
}) {
  const { review, guide, sections, go, snooze, files } = useWorkspace();
  const isPr = review.kind === "pr";
  const changed = changedSince ? sections.find((section) => changedSince[section.id] > 0) : undefined;
  const resumed = sections.find((section) => section.id === resume);
  // Where reading goes on: the chapter you left, or on a re-review the first one that changed.
  const [cta, next] = resumed ? ["Continue", resumed] : changed ? ["Review changes", changed] : ["Start reading", sections[0]];
  return (
    <div className="mx-auto max-w-5xl space-y-5 pb-4">
      <div>
        <ReviewHeader review={review} checks={checks} intent={guide.intent} sinceReview={guide.sinceReview} requirements={guide.requirements} onOpenLine={onOpenLine} onShowFeedback={onShowFeedback} onSnooze={isPr ? (snoozed, until) => void snooze(snoozed, until) : undefined} snoozing={snoozing} readLines={readLines} trailing={trailing} />
        {guide.hotspots && guide.hotspots.length > 0 && <StartHere hotspots={guide.hotspots} onOpen={onOpenLine} />}
      </div>
      {next && (
        <Button className="max-w-full justify-start gap-2" onClick={() => go(next.id)}>
          <span className="truncate">{cta}: <InlineCode text={next.title} /></span>
          <Icon name="ArrowRight" aria-hidden />
        </Button>
      )}
      <section aria-label="Chapters" className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Chapters</h3>
        <ol className="space-y-1">
          {sections.map((section, index) => {
            const viewed = section.diffs.filter((diff) => files.views.get(diff.file)?.viewed).length;
            const done = section.diffs.length > 0 && viewed === section.diffs.length;
            const skippable = section.diffs.filter((diff) => classifyFile(diff.file, generated?.has(diff.file)).skippable).length;
            const changedFiles = changedSince?.[section.id] ?? 0;
            return (
              <li key={section.id}>
                <button type="button" onClick={() => go(section.id)} className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">
                  <span aria-hidden className={cn("mt-px flex size-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ring-1 ring-inset", done ? "bg-success text-background ring-success" : "text-muted-foreground ring-border")}>
                    {done ? <Icon name="Check" className="size-3" /> : index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground"><InlineCode text={section.title} /></span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                      {section.risk && section.risk !== "low" && <Badge tone={RISK_TONE[section.risk] ?? "neutral"} size="sm">{RISK_LABEL[section.risk] ?? section.risk}</Badge>}
                      <span className="tabular-nums">{viewed > 0 ? `${viewed} of ` : ""}{section.diffs.length} file{section.diffs.length === 1 ? "" : "s"}{viewed > 0 ? " viewed" : ""}</span>
                      {changedFiles > 0 && <span className="text-primary">· {changedFiles} changed</span>}
                      {skippable > 0 && <span>· {skippable} skippable</span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
});
ReviewOverview.displayName = "ReviewOverview";
