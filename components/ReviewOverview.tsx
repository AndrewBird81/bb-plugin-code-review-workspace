import { memo, useId, useState, type ReactNode } from "react";
import { Markdown, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { z } from "zod";
import type { rpcContract } from "../src/rpc-contract";
import type { RequirementSchema } from "../src/guide";
import { classifyFile } from "../src/classify";
import { untrusted } from "../src/untrusted";
import { changedInstructions } from "../lib/instruction-files";
import { linkImages } from "../lib/link-images";
import { useKnob } from "../lib/settings";
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
function Requirements({ requirements, onOpen }: { requirements: Requirement[]; onOpen: (file: string, line: number, side: "LEFT" | "RIGHT") => void }) {
  return (
    <ul aria-label="Requirements" className="space-y-2.5">
      {requirements.map(({ text, status, evidence, file, line, side = "RIGHT" }, index) => {
        const look = REQUIREMENT_LOOK[status];
        const at = `${file}:${line}${side === "LEFT" ? " (removed line)" : ""}`;
        return (
          // Where the page is narrow, the requirement takes the row under its status and line.
          <li key={index} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-start gap-x-2.5 @max-[480px]/overview:grid-cols-[minmax(0,1fr)_auto]">
            <span className={cn("flex items-center gap-1.5 text-xs font-medium leading-6", TONE_TEXT[look.tone])}><Icon name={look.icon} className="size-3.5 shrink-0" aria-hidden />{look.label}</span>
            <span className="min-w-0 text-sm leading-6 @max-[480px]/overview:col-span-2 @max-[480px]/overview:row-start-2">
              <span className="text-foreground/90"><InlineCode text={text} /></span>
              <span className="block text-xs leading-5 text-muted-foreground"><InlineCode text={evidence} /></span>
            </span>
            {file && line && (
              <button type="button" aria-label={at} title={at} className="col-start-3 row-start-1 justify-self-end rounded-sm font-mono text-xs leading-6 text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring @max-[480px]/overview:col-start-2 pointer-coarse:-my-2.5 pointer-coarse:min-h-11" onClick={() => onOpen(file, line, side)}>
                {file.split("/").pop()}:{line}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A GitHub Actions run's id, from its check's link; other checks have no log to read. */
function actionsRunId(link: string | undefined): number | null {
  const id = link?.match(/\/actions\/runs\/(\d+)/)?.[1];
  return id ? Number(id) : null;
}

/** `text` in a code fence longer than any run of backticks in it, so nothing in it ends the fence. */
function codeFence(text: string): string {
  const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length + 1)));
  return `${fence}text\n${text}\n${fence}`;
}

/** A failing check's Ask agent: it reads the end of the check's failed log and quotes it into the agent's box, unsent. */
function AskAboutCheck({ name, runId }: { name: string; runId: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const { targetKey, askAgent } = useWorkspace();
  const [reading, setReading] = useState(false);
  async function ask() {
    setReading(true);
    try {
      const result = await rpc.call("getCheckLog", { targetKey, runId });
      if (!result.ok || !result.log) toast.error(result.error ?? "Couldn’t read the check’s log.");
      // The log is the PR's CI output, to read as data.
      else askAgent({}, `The check **${name}** fails. The end of its log:\n${codeFence(untrusted("CI log", result.log))}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t read the check’s log.");
    } finally { setReading(false); }
  }
  return (
    <button type="button" aria-label={reading ? undefined : `Ask agent about ${name}`} disabled={reading} onClick={() => void ask()}
      className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs text-(--ansi-13) hover:underline disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:min-h-11">
      {reading ? <><Icon name="Loading" className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />Reading the log…</> : <><Icon name="Sparkles" className="size-3" aria-hidden />Ask agent</>}
    </button>
  );
}

/** The instruction files a change edits, which the agents read at its base instead, in one muted line. */
function InstructionChanges({ files, pr, className }: { files: string[]; pr: boolean; className?: string }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs leading-5 text-muted-foreground", className)}>
      <Icon name="Info" className="mt-[3px] size-3.5 shrink-0" aria-hidden />
      <span>
        {pr ? "This PR" : "This diff"} changes{" "}
        {files.map((file, index) => <span key={file}>{index > 0 && (index === files.length - 1 ? `${files.length > 2 ? "," : ""} and ` : ", ")}<span className="font-mono">{file}</span></span>)}
        , which the agents read; they use the base {files.length > 1 ? "versions" : "version"}.
      </span>
    </p>
  );
}

/** The checks that need a look, failing first, each linking to its run; a failing Actions run offers Ask agent, unless Settings turns it off. */
function CheckList({ checks }: { checks: Checks["checks"] }) {
  const askable = useKnob("checkFailureActions");
  return (
    <ul aria-label="Checks" className="space-y-1.5">
      {checks.map((check, index) => {
        const runId = askable && check.bucket === "fail" ? actionsRunId(check.link) : null;
        return (
          <li key={`${check.name}:${index}`} className="flex min-w-0 items-center gap-2 text-sm leading-6">
            {check.bucket === "fail" ? <Icon name="CircleX" className={cn("size-3.5 shrink-0", TONE_TEXT.danger)} aria-hidden /> : <span className="flex size-3.5 shrink-0 items-center justify-center"><Dot tone="warning" pulse /></span>}
            <span className="min-w-0 truncate text-foreground/90">{check.name}</span>
            <span className={cn("shrink-0 text-xs", check.bucket === "fail" ? TONE_TEXT.danger : TONE_TEXT.warning)}>{check.bucket === "fail" ? "Failing" : "Pending"}</span>
            {(runId || check.link) && <span className="ml-auto flex shrink-0 items-center gap-3">
              {runId && <AskAboutCheck name={check.name} runId={runId} />}
              {check.link && <UrlLink href={check.link} className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs text-primary hover:underline pointer-coarse:min-h-11">View check<Icon name="ArrowUpRight" className="size-3" aria-hidden /></UrlLink>}
            </span>}
          </li>
        );
      })}
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
  onOpenLine: (file: string, line: number, side: "LEFT" | "RIGHT") => void;
}) {
  const { review, guide, sections, go, snooze, files } = useWorkspace();
  const changed = changedSince ? sections.find((section) => changedSince[section.id] > 0) : undefined;
  const resumed = sections.find((section) => section.id === resume);
  // Where reading goes on: the chapter you left, or on a re-review the first one that changed, else the first.
  const [cta, next] = resumed ? ["Continue", resumed] : changed ? ["Review changes", changed] : ["Start reading", sections[0]];
  const nextIndex = next ? sections.indexOf(next) : -1;
  const requirements = useKnob("requirements") ? guide.requirements ?? [] : [];
  const reviewMd = useKnob("reviewMd");
  const instructions = reviewMd ? changedInstructions([...new Set(sections.flatMap((section) => section.diffs.map((diff) => diff.file)))], true) : [];
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
            <Markdown content={linkImages(guide.sinceReview)} className="max-w-[80ch] text-sm leading-relaxed text-foreground/90" />
          </Section>
        )}
        {(guide.intent || instructions.length > 0) && (
          <Section title="What and why">
            {guide.intent && <Markdown content={linkImages(guide.intent)} className="max-w-[80ch] text-sm leading-relaxed text-foreground/90" />}
            {instructions.length > 0 && <InstructionChanges files={instructions} pr={review.kind === "pr"} className={guide.intent ? "mt-2" : undefined} />}
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
