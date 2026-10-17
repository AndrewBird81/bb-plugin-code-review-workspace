import { createContext, memo, useContext, useEffect, useState } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../src/rpc-contract";
import { sameLocation, type CommentLocation } from "../src/draft";
import { codeFence, untrusted } from "../src/untrusted";
import { setCommentOpen, useCommentOpen } from "../lib/comments-fold";
import { linkImages } from "../lib/link-images";
import { useKnob } from "../lib/settings";
import { cn } from "../lib/utils";
import { useWorkspace } from "../lib/workspace-context";
import { TOUCH_TARGET } from "./touch";
import { Icon } from "./ui/icon";
import { InlineDraftContext } from "./InlineDraft";
import { CommentPill } from "./comments/CommentPill";
import { useComments } from "./comments/store";

export type CheckFailure = z.infer<typeof rpcContract.getCheckFailures.output>["failures"][number];

/** CI failures at the reviewed head, which the diff shows on their new-file lines. */
export const CheckFailuresContext = createContext<CheckFailure[]>([]);

export const failureLocation = (failure: CheckFailure): CommentLocation => ({ file: failure.file, line: failure.line, side: "RIGHT" });

/**
 * Reads a PR's CI failures at the reviewed head, while Settings shows them in the code: again when the PR's CI state
 * changes, since a check that fails after the review opened has its failures only then.
 */
export function useCheckFailures(targetKey: string, headSha: string | null, ci?: string): CheckFailure[] {
  const rpc = useRpc<typeof rpcContract>();
  const on = useKnob("ciInCode");
  const [failures, setFailures] = useState<CheckFailure[]>([]);
  useEffect(() => {
    setFailures([]);
    if (!headSha || !on) return;
    let cancelled = false;
    rpc.call("getCheckFailures", { targetKey }).then(({ failures }) => { if (!cancelled) setFailures(failures); }).catch(() => {});
    return () => { cancelled = true; };
  }, [rpc, targetKey, headSha, ci, on]);
  return failures;
}

/**
 * A failing check quoted in Markdown: "> **‹check›** · ‹title›", then its message, every line quoted. The PR's code
 * writes the message, and your own comments show their images, so its images are links.
 */
function failureQuote(failure: Pick<CheckFailure, "check" | "title" | "message">): string {
  return linkImages([`**${failure.check}**${failure.title ? ` · ${failure.title}` : ""}`, ...failure.message.trim().split("\n")].map((line) => `> ${line}`.trimEnd()).join("\n"));
}

/** A failing check as the agent reads it: "‹check› · ‹title›", then its message, as data, since the PR's code writes it. */
const failureData = (failure: Pick<CheckFailure, "check" | "title" | "message">) =>
  codeFence(untrusted("CI annotation", [`${failure.check}${failure.title ? ` · ${failure.title}` : ""}`, failure.message.trim()].join("\n")));

/**
 * A failure's Comment, which opens the comment box at its line with Blocking set and the failure quoted, and Ask agent,
 * which puts it in the agent's box, fenced, unsent. Only inside the workspace, where a line has failures.
 */
function FailureActions({ failure }: { failure: CheckFailure }) {
  const draft = useContext(InlineDraftContext);
  const { askAgent, activeId } = useWorkspace();
  const at = failureLocation(failure);
  const action = `relative shrink-0 text-primary hover:underline disabled:pointer-events-none disabled:opacity-50 ${TOUCH_TARGET}`;
  return <>
    {draft?.editable && <button type="button" className={action} disabled={draft.busy || draft.writing} aria-label={`Comment on the ${failure.check} failure at ${failure.file}:${failure.line}`}
      onClick={() => draft.open(at, { body: `${failureQuote(failure)}\n\n`, severity: "blocking" })}>Comment</button>}
    <button type="button" className={`${action} text-(--ansi-13)`} aria-label={`Ask agent about the ${failure.check} failure at ${failure.file}:${failure.line}`}
      onClick={() => askAgent({ file: failure.file, startLine: failure.line, endLine: failure.line, side: "additions", chapterId: activeId }, `In \`${failure.file}\` line ${failure.line}, a check fails:\n${failureData(failure)}`)}>Ask agent</button>
  </>;
}

const viewCheck = (failure: CheckFailure) => <UrlLink href={failure.url} className={`relative shrink-0 text-primary hover:underline ${TOUCH_TARGET}`}>View check</UrlLink>;

/**
 * A line's CI failures, each linking to its check, and with Settings' check failure actions on, Comment and Ask agent.
 * With comments folded, a pill: "Check failed · ‹name›".
 */
export const LineChecks = memo(function LineChecks({ at }: { at: CommentLocation }) {
  const here = useContext(CheckFailuresContext).filter((failure) => sameLocation(failureLocation(failure), at));
  const targetKey = useContext(InlineDraftContext)?.targetKey;
  const id = `check:${at.file}:${at.line}`;
  const folded = useComments(targetKey, "folded");
  const opened = useCommentOpen(targetKey, id);
  const actions = useKnob("checkFailureActions");
  if (!here.length) return null;
  if (folded && !opened && targetKey) {
    return <CommentPill frame="border border-destructive/30" icon={<Icon name="CircleX" className="size-3.5 shrink-0 text-destructive-text" aria-hidden />} who={null}
      words={`Check failed · ${here[0].check}`} text={here[0].title ?? here[0].message} more={here.length > 1 ? `${here.length} failures` : null}
      name={`CI failure on ${at.file}:${at.line}`} onShow={() => setCommentOpen(targetKey, id, true)} />;
  }
  return (
    <div className="mx-2 my-2 max-w-3xl space-y-1 rounded-lg [contain:inline-size] border border-destructive/30 bg-destructive/10 px-3 py-2 font-sans text-xs leading-normal whitespace-normal text-foreground">
      {here.map((failure, index) => (
        // With its actions, where the note is narrow, its links go under the message, at its end.
        <div key={index} role="note" aria-label={`CI failure on ${failure.file}:${failure.line}`} className={actions ? "flex flex-wrap items-start gap-x-2 gap-y-1" : "flex items-start gap-2"}>
          <Icon name="CircleX" className="mt-0.5 size-3.5 shrink-0 text-destructive-text" aria-hidden />
          <p className={cn(actions ? "min-w-[min(100%_-_1.5rem,16rem)]" : "min-w-0", "flex-1 break-words")}>
            <span className="font-medium text-destructive-text">{failure.check}</span>
            {failure.title && <span className="font-medium"> · {failure.title}</span>}
            <span className="whitespace-pre-wrap text-muted-foreground"> {failure.message}</span>
          </p>
          {actions
            ? <span className="ml-auto flex shrink-0 gap-x-3"><FailureActions failure={failure} />{viewCheck(failure)}</span>
            : viewCheck(failure)}
        </div>
      ))}
    </div>
  );
});
LineChecks.displayName = "LineChecks";
