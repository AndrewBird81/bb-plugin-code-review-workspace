import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { ReviewThread } from "../src/threads";
import { sameLocation, type CommentLocation } from "../src/draft";
import { withLineBreaks } from "../src/line-breaks";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Badge } from "./ui/badge";
import { Avatar } from "./ui/avatar";
import { Textarea } from "./ui/textarea";
import { action, bar } from "./InlineDraft";

/** The PR's review threads on GitHub, everyone's, as the diff shows them. The workspace provides it while they're shown. */
export interface DiffThreads {
  threads: ReviewThread[];
  /** The thread a reply or resolve is being sent on. */
  busy: string | null;
  reply(thread: ReviewThread, body: string): Promise<boolean>;
  toggleResolved(thread: ReviewThread): void;
}
export const DiffThreadsContext = createContext<DiffThreads | null>(null);

/** A thread's line in the diff, unless GitHub says the code it was on has changed. */
export function threadLocation(thread: ReviewThread): CommentLocation | null {
  return thread.path && thread.line != null && !thread.isOutdated ? { file: thread.path, line: thread.line, side: thread.side } : null;
}

/** Reads the PR's threads whenever `enabled` turns on, so changes made in the Threads view show. */
export function useDiffThreads(targetKey: string, enabled: boolean): DiffThreads {
  const rpc = useRpc<typeof rpcContract>();
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    // The Threads view says when GitHub can't be read; the diff just shows what it has.
    const result = await rpc.call("getReviewThreads", { targetKey }).catch(() => null);
    if (result) setThreads(result.threads as ReviewThread[]);
  }, [rpc, targetKey]);
  useEffect(() => { if (enabled) void load(); }, [enabled, load]);
  const send = useCallback(async (thread: ReviewThread, request: () => Promise<{ ok: boolean; error?: string }>, failed: string) => {
    setBusy(thread.id);
    try {
      const result = await request();
      if (!result.ok) toast.error(result.error ?? failed);
      else await load();
      return result.ok;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : failed);
      return false;
    } finally {
      setBusy(null);
    }
  }, [load]);
  const reply = useCallback((thread: ReviewThread, body: string) => {
    const inReplyTo = thread.comments[0]?.databaseId;
    return inReplyTo == null ? Promise.resolve(false) : send(thread, () => rpc.call("replyToThread", { targetKey, inReplyTo, body }), "Couldn’t send the reply.");
  }, [rpc, targetKey, send]);
  const toggleResolved = useCallback((thread: ReviewThread) => {
    void send(thread, () => rpc.call(thread.isResolved ? "unresolveThread" : "resolveThread", { targetKey, threadId: thread.id }), "Couldn’t update the thread.");
  }, [rpc, targetKey, send]);
  return useMemo(() => ({ threads, busy, reply, toggleResolved }), [threads, busy, reply, toggleResolved]);
}

// Like a draft comment's card, but GitHub's: no colored edge, since it's neither yours in the draft nor the agent's.
const card = "mx-2 my-2 max-w-3xl overflow-hidden rounded-lg border border-border bg-card font-sans text-sm leading-normal whitespace-normal text-foreground shadow-md";

const where = (thread: ReviewThread) => `${thread.path ?? "unknown file"}${thread.line != null ? `:${thread.line}` : ""}${thread.line != null && thread.side === "LEFT" ? " (LEFT side)" : ""}`;

/** One GitHub thread, read-only but for Reply and Resolve. A resolved thread starts folded. */
function ThreadCard({ thread, github, className }: { thread: ReviewThread; github: DiffThreads; className?: string }) {
  const [open, setOpen] = useState(!thread.isResolved);
  const [replying, setReplying] = useState(false);
  const [body, setBody] = useState("");
  const [first, ...replies] = thread.comments;
  const busy = github.busy === thread.id;
  async function send() {
    if (await github.reply(thread, body.trim())) { setBody(""); setReplying(false); }
  }
  return (
    <article aria-label={`GitHub thread on ${where(thread)}`} className={cn(card, className)}>
      <div className={cn(bar, !open && "border-b-0")}>
        <Icon name="Github" className="size-3.5 shrink-0" aria-hidden />
        {first && <span className="flex items-center gap-1.5 font-medium text-foreground"><Avatar login={first.author} size={16} />{first.author}</span>}
        {replies.length > 0 && <span>{replies.length} {replies.length === 1 ? "reply" : "replies"}</span>}
        {thread.isResolved && <Badge tone="success" size="sm">Resolved</Badge>}
        {thread.isOutdated && <Badge tone="warning" size="sm">Outdated</Badge>}
        <span className="ml-auto flex">
          <Button variant="ghost" size="sm" className={action} onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"}</Button>
          {open && !replying && <Button variant="ghost" size="sm" className={action} disabled={busy} onClick={() => setReplying(true)}>Reply</Button>}
          <Button variant="ghost" size="sm" className={action} disabled={busy} onClick={() => github.toggleResolved(thread)}>{thread.isResolved ? "Unresolve" : "Resolve"}</Button>
        </span>
      </div>
      {open && (
        <ul className="space-y-3 px-3 py-2.5">
          {thread.comments.map((comment) => (
            <li key={comment.id} className="space-y-1">
              {comment !== first && <span className="flex items-center gap-1.5 text-xs font-medium text-foreground"><Avatar login={comment.author} size={16} />{comment.author}</span>}
              <Markdown content={withLineBreaks(comment.body)} className={cn("text-sm leading-relaxed", comment !== first && "pl-[22px]")} />
            </li>
          ))}
        </ul>
      )}
      {open && replying && (
        <div className="space-y-2 border-t border-border px-3 py-2.5">
          <Textarea autoFocus value={body} onChange={(event) => setBody(event.target.value)} aria-label={`Reply on ${where(thread)}`} placeholder="Reply on GitHub…" className="min-h-16" />
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" className={action} onClick={() => setReplying(false)}>Cancel</Button>
            <Button size="sm" className={action} disabled={busy || !body.trim()} onClick={() => void send()}>Send reply</Button>
          </div>
        </div>
      )}
    </article>
  );
}

/** The GitHub threads on a line of the diff, above its draft comment. */
export const LineThreads = memo(function LineThreads({ at }: { at: CommentLocation }) {
  const github = useContext(DiffThreadsContext);
  const here = github?.threads.filter((thread) => { const on = threadLocation(thread); return on && sameLocation(on, at); }) ?? [];
  return <>{here.map((thread) => <ThreadCard key={thread.id} thread={thread} github={github!} />)}</>;
});
LineThreads.displayName = "LineThreads";

/** A file's threads with no line in this diff: outdated, or on code since changed. Folded until asked for. */
export function OutdatedThreads({ threads }: { threads: ReviewThread[] }) {
  const github = useContext(DiffThreadsContext);
  const [open, setOpen] = useState(false);
  if (!github || !threads.length) return null;
  return (
    <div className="border-b border-border">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
        <Icon name="ChevronDown" className={cn("size-3.5 transition-transform duration-150", !open && "-rotate-90")} aria-hidden />
        {threads.length} outdated thread{threads.length === 1 ? "" : "s"}
      </button>
      {open && threads.map((thread) => <ThreadCard key={thread.id} thread={thread} github={github} className="max-w-none" />)}
    </div>
  );
}
