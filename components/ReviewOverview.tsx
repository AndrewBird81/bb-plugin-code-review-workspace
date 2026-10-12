import { memo, useId, type ReactNode } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { RequirementSchema } from "../src/guide";
import { classifyFile } from "../src/classify";
import { cn } from "../lib/utils";
import { useWorkspace } from "../lib/workspace-context";
import { RISK_LABEL, RISK_TONE, StepMarker } from "./ChapterNav";
import { ReviewHeader, type Checks } from "./ReviewHeader";
import { MetaLine } from "./MetaLine";
import { StartHere } from "./StartHere";
import { TOUCH_CONTROL } from "./touch";
import { Badge, Dot, TONE_TEXT, type Tone } from "./ui/badge";
import { Button } from "./ui/button";
import { Icon, type IconName } from "./ui/icon";
import { InlineCode } from "./ui/inline-code";

type Requirement = z.infer<typeof RequirementSchema>;
const REQUIREMENT_LOOK: Record<Requirement["status"], { tone: Tone; icon: IconName; label: string }> = {
  covered: { tone: "success", icon: "CircleCheck", label: "Covered" },
  partial: { tone: "warning", icon: "AlertCircle", label: "Partial" },
  missing: { tone: "danger", icon: "CircleX", label: "Missing" },
  unclear: { tone: "neutral", icon: "CircleQuestion", label: "Unclear" },
};

/** One of the Overview's sections: its name beside it where the page has room, above it where it hasn't. */
function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-x-6 gap-y-2 py-4 @min-[560px]/overview:grid-cols-[9rem_minmax(0,1fr)]">
      <h3 id={id} className="text-sm font-medium leading-6 text-muted-foreground">{title}</h3>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** What the PR asks for and whether the diff does it, each with its evidence, a covered one opening its line. */
function Requirements({ requirements, onOpen }: { requirements: Requirement[]; onOpen: (file: string, line: number) => void }) {
  return (
    <ul aria-label="Requirements" className="space-y-2.5">
      {requirements.map(({ text, status, evidence, file, line }, index) => {
        const look = REQUIREMENT_LOOK[status];
        return (
          // Where the page is narrow, the requirement takes the row under its status and line.
          <li key={index} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-start gap-x-2.5 @max-[480px]/overview:grid-cols-[minmax(0,1fr)_auto]">
            <span className={cn("flex items-center gap-1.5 text-xs font-medium leading-6", TONE_TEXT[look.tone])}><Icon name={look.icon} className="size-3.5 shrink-0" aria-hidden />{look.label}</span>
            <span className="min-w-0 text-sm leading-6 @max-[480px]/overview:col-span-2 @max-[480px]/overview:row-start-2">
              <span className="text-foreground/90"><InlineCode text={text} /></span>
              <span className="block text-xs leading-5 text-muted-foreground"><InlineCode text={evidence} /></span>
            </span>
            {file && line && (
              <button type="button" aria-label={`${file}:${line}`} title={`${file}:${line}`} className="col-start-3 row-start-1 justify-self-end rounded-sm font-mono text-xs leading-6 text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring @max-[480px]/overview:col-start-2 pointer-coarse:-my-2.5 pointer-coarse:min-h-11" onClick={() => onOpen(file, line)}>
                {file.split("/").pop()}:{line}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The checks that need a look, failing first, each linking to its run. */
function CheckList({ checks }: { checks: Checks["checks"] }) {
  return (
    <ul aria-label="Checks" className="space-y-1.5">
      {checks.map((check, index) => (
        <li key={`${check.name}:${index}`} className="flex min-w-0 items-center gap-2 text-sm leading-6">
          {check.bucket === "fail" ? <Icon name="CircleX" className={cn("size-3.5 shrink-0", TONE_TEXT.danger)} aria-hidden /> : <span className="flex size-3.5 shrink-0 items-center justify-center"><Dot tone="warning" pulse /></span>}
          <span className="min-w-0 truncate text-foreground/90">{check.name}</span>
          <span className={cn("shrink-0 text-xs", check.bucket === "fail" ? TONE_TEXT.danger : TONE_TEXT.warning)}>{check.bucket === "fail" ? "Failing" : "Pending"}</span>
          {check.link && <UrlLink href={check.link} className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm text-xs text-primary hover:underline pointer-coarse:min-h-11">View check<Icon name="ArrowUpRight" className="size-3" aria-hidden /></UrlLink>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The review's first page, before its chapters: what the PR is and where it stands, the way into its chapters, then
 * what changed since your review, what and why, what to read first, what it asks for, checks that need a look, and the
 * chapters themselves.
 */
export const ReviewOverview = memo(function ReviewOverview({ checks, readLines, changedSince, generated, snoozing, resume, onShowFeedback, onOpenLine }: {
  checks: Checks | null;
  /** The changed lines worth reading (lib/review-size.ts readingLines). */
  readLines: number;
  /** Per chapter id, how many of its files changed since your review. */
  changedSince?: Record<string, number>;
  /** Files the repo's .gitattributes marks generated or vendored. */
  generated?: ReadonlySet<string>;
  snoozing: boolean;
  /** The chapter you were reading, to continue from. */
  resume?: string;
  /** Your feedback's progress opens it in Comments. */
  onShowFeedback?: () => void;
  onOpenLine: (file: string, line: number) => void;
}) {
  const { review, guide, sections, go, snooze, files } = useWorkspace();
  const changed = changedSince ? sections.find((section) => changedSince[section.id] > 0) : undefined;
  const resumed = sections.find((section) => section.id === resume);
  // Where reading goes on: the chapter you left, or on a re-review the first one that changed, else the first.
  const [cta, next] = resumed ? ["Continue", resumed] : changed ? ["Review changes", changed] : ["Start reading", sections[0]];
  const nextIndex = next ? sections.indexOf(next) : -1;
  const requirements = guide.requirements ?? [];
  const covered = requirements.filter((requirement) => requirement.status === "covered").length;
  // Passing checks are a fact in the status line; these need a look.
  const unsettled = [...(checks?.checks.filter((check) => check.bucket === "fail") ?? []), ...(checks?.checks.filter((check) => check.bucket === "pending") ?? [])];
  return (
    <div className="@container/overview mx-auto max-w-3xl pb-4">
      <ReviewHeader
        review={review}
        checks={checks}
        readLines={readLines}
        onShowFeedback={onShowFeedback}
        onSnooze={review.kind === "pr" ? (snoozed, until) => void snooze(snoozed, until) : undefined}
        snoozing={snoozing}
        action={next && (
          <Button className={cn("min-w-0 max-w-full justify-start gap-2 @max-[480px]/overview:w-full", TOUCH_CONTROL)} onClick={() => go(next.id)}>
            <span className="truncate">{cta}:{" "}<span aria-hidden className="mr-1.5 inline-flex size-[18px] items-center justify-center rounded-full bg-primary-foreground/15 align-[1px] text-[10px] font-semibold tabular-nums">{nextIndex + 1}</span><InlineCode text={next.title} /></span>
            <Icon name="ArrowRight" aria-hidden />
          </Button>
        )}
      />
      <div className="mt-5 divide-y divide-border border-t border-border">
        {guide.sinceReview && (
          <Section title="Since your review">
            <Markdown content={guide.sinceReview} className="max-w-[80ch] text-sm leading-relaxed text-foreground/90" />
          </Section>
        )}
        {guide.intent && (
          <Section title="What and why">
            <Markdown content={guide.intent} className="max-w-[80ch] text-sm leading-relaxed text-foreground/90" />
          </Section>
        )}
        {!!guide.hotspots?.length && <Section title="Start here"><StartHere hotspots={guide.hotspots} onOpen={onOpenLine} /></Section>}
        {/* In the label column, how many are covered goes under the label, rather than after a dot at a line's end. */}
        {requirements.length > 0 && <Section title={<>Requirements<span className="@min-[560px]/overview:hidden">{"\u00a0·"}</span> <span className="whitespace-nowrap @min-[560px]/overview:block">{covered} of {requirements.length} covered</span></>}><Requirements requirements={requirements} onOpen={onOpenLine} /></Section>}
        {unsettled.length > 0 && <Section title="Checks"><CheckList checks={unsettled} /></Section>}
        <Section title="Chapters">
          <ol className="-mx-2 space-y-px">
            {sections.map((section, index) => {
              const viewed = section.diffs.filter((diff) => files.views.get(diff.file)?.viewed).length;
              const total = section.diffs.length;
              const skippable = section.diffs.filter((diff) => classifyFile(diff.file, generated?.has(diff.file)).skippable).length;
              const changedFiles = changedSince?.[section.id] ?? 0;
              return (
                <li key={section.id}>
                  <button type="button" onClick={() => go(section.id)} className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">
                    <StepMarker index={index} viewed={viewed} total={total} active={false} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium leading-snug text-foreground"><InlineCode text={section.title} /></span>
                      <MetaLine className="mt-1 tabular-nums" items={[
                        section.risk && section.risk !== "low" && <Badge tone={RISK_TONE[section.risk] ?? "neutral"} size="sm" className="align-[-2px]">{RISK_LABEL[section.risk] ?? section.risk}</Badge>,
                        viewed > 0 ? `${viewed} of ${total} viewed` : `${total} ${total === 1 ? "file" : "files"}`,
                        changedFiles > 0 && <span className="text-primary">{changedFiles} changed</span>,
                        skippable > 0 && `${skippable} skippable`,
                      ]} />
                      {section.overview && <span className="mt-1 line-clamp-2 block text-xs leading-snug text-muted-foreground"><InlineCode text={section.overview} /></span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </Section>
      </div>
    </div>
  );
});
ReviewOverview.displayName = "ReviewOverview";
