import { useEffect, useState } from "react";
import { experimental_useSidebarThreads, ThreadTitle, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import type { SourceThread } from "../src/fix-handoff";
import { linesOf, type DraftComment } from "../src/draft";
import { useKnob } from "../lib/settings";
import { TOUCH_CONTROL, TOUCH_TARGET } from "./touch";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Textarea } from "./ui/textarea";
import { locationKey } from "./InlineDraft";
import { useDraft } from "./DraftProvider";

const LINK = `relative rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${TOUCH_TARGET}`;

/** A thread's title as BB's thread list shows it, or as it was read, where the list doesn't have it. */
function ThreadName({ threadId, title }: { threadId: string; title: string | null }) {
  const listed = experimental_useSidebarThreads().threads.some((thread) => thread.id === threadId);
  return <span className="inline-block min-w-0 max-w-full truncate align-bottom font-medium text-foreground">{listed ? <ThreadTitle threadId={threadId} /> : title ?? "the thread that made the change"}</span>;
}

/**
 * Hands the draft comments you choose on your own change to a BB thread: the one `bb review` ran in, which made the
 * change, while it's open and Send to thread is on, or else a new visible thread. With no comments, it tells that
 * thread you approve the diff at `revision`, once. Either can go with your message and the summary.
 */
export function FixHandoff({ targetKey, comments, revision }: { targetKey: string; comments: readonly DraftComment[]; revision: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const sendOn = useKnob("sendToThread");
  const { review, draft } = useDraft();
  const sourceId = review?.sourceThreadId ?? null;
  const [source, setSource] = useState<SourceThread | null>(null);
  // What the picker is for: sending comments or an approval to the source thread, or a new thread.
  const [choosing, setChoosing] = useState<"send" | "approve" | "fix" | null>(null);
  // The comments you left out; ones added meanwhile are in.
  const [left, setLeft] = useState<string[]>([]);
  // What goes with what you send to the source thread.
  const [message, setMessage] = useState("");
  const [withSummary, setWithSummary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ threadId: string; title: string } | null>(null);
  // An approval's is for the diff it approved.
  const [sent, setSent] = useState<{ threadId: string; title: string | null; delivery: "sent" | "queued"; revision?: string } | null>(null);
  useEffect(() => {
    setSource(null);
    if (!sendOn || !sourceId) return;
    let current = true;
    // Without an answer, Fix in a new thread is all there is.
    rpc.call("getSourceThread", { targetKey }).then(({ thread }) => { if (current) setSource(thread); }, () => {});
    return () => { current = false; };
  }, [rpc, targetKey, sendOn, sourceId]);
  const chosen = comments.filter((comment) => !left.includes(locationKey(comment)));
  const open = sendOn && source?.state === "open" ? source : null;
  const approval = review?.approvalSent;
  const approved = sendOn && approval?.threadId === sourceId && approval.revision === revision ? approval : null;
  // What the thread was told: sent from here, or an approval of this diff, sent before, while there are no comments.
  const told = sent ?? (approved && !comments.length ? { ...approved, delivery: "sent" as const } : null);
  const approvable = !!open && !comments.length && !approved && sent?.revision !== revision;
  if (!comments.length && !started && !told && !approvable) return null;
  // An approval's form closes once there's nothing to approve.
  const picking = choosing === "approve" && !approvable ? null : choosing;
  const summary = draft.body.trim();
  const picked = () => chosen.map(({ file, line, side }) => ({ file, line, side }));
  const extras = () => ({ ...(message.trim() ? { message: message.trim() } : {}), ...(withSummary && summary ? { includeSummary: true } : {}) });
  async function start() {
    setBusy(true); setError(null);
    try {
      setStarted(await rpc.call("startFixThread", { targetKey, comments: picked() }));
      setChoosing(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn’t start the thread. Try again.");
    } finally { setBusy(false); }
  }
  async function send(to: SourceThread) {
    setBusy(true); setError(null);
    try {
      const result = await rpc.call("sendToSourceThread", { targetKey, comments: picked(), ...extras() });
      setSent({ threadId: to.threadId, title: result.title, delivery: result.delivery });
      setChoosing(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn’t send to the thread. Try again.");
    } finally { setBusy(false); }
  }
  async function approve(to: SourceThread) {
    setBusy(true); setError(null);
    try {
      const result = await rpc.call("sendApprovalToSourceThread", { targetKey, ...extras() });
      setSent({ threadId: to.threadId, title: result.title, delivery: result.delivery, revision });
      setChoosing(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn’t send to the thread. Try again.");
    } finally { setBusy(false); }
  }
  const choose = (what: "send" | "approve" | "fix") => { setChoosing(what); setLeft([]); setMessage(""); setWithSummary(false); setError(null); };
  const spinner = <Icon name="Loading" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />;
  const count = `${comments.length} comment${comments.length === 1 ? "" : "s"}`;
  return <section aria-label={open ? "Send to thread" : "Fix in a new thread"} className="space-y-2 border-t border-border pt-3">
    {told && <p role="status" className="min-w-0 text-xs text-muted-foreground">{told.delivery === "queued" ? "Queued in" : "Sent to"} <ThreadName threadId={told.threadId} title={told.title} /> · <button type="button" className={LINK} onClick={() => navigate.toThread(told.threadId)}>Open</button></p>}
    {started && <p role="status" className="text-xs text-muted-foreground">Started a thread: <span className="text-foreground">{started.title}</span> · <button type="button" className={LINK} onClick={() => navigate.toThread(started.threadId)}>Open</button></p>}
    {error && <p role="alert" className="text-xs text-destructive-text">{error}</p>}
    {sendOn && source && source.state !== "open" && <p className="text-xs text-muted-foreground">{source.state === "archived" ? `${source.title ?? "The thread that made the change"} is archived.` : "The thread that made the change was deleted."}</p>}
    {picking ? <fieldset className="space-y-2">
      <legend className="mb-2 text-xs font-medium">{picking === "approve" ? "Approval to send" : picking === "send" ? "Comments to send" : "Comments to fix"}</legend>
      {picking !== "approve" && comments.map((comment) => {
        const key = locationKey(comment);
        return <label key={key} className="flex items-start gap-2.5 text-xs pointer-coarse:min-h-11 pointer-coarse:items-center">
          <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" disabled={busy} checked={!left.includes(key)} onChange={(event) => setLeft(event.target.checked ? left.filter((k) => k !== key) : [...left, key])} />
          <span className="min-w-0"><span className="font-mono text-[11px]">{comment.file}:{linesOf(comment)}</span> <span className="line-clamp-1 break-words text-muted-foreground">{comment.body}</span></span>
        </label>;
      })}
      {picking !== "fix" && open && <>
        <label className="block space-y-1"><span className="text-xs font-medium">Message (optional)</span><Textarea autoFocus rows={3} maxLength={65_000} disabled={busy} value={message} className="min-h-16 bg-background text-sm" onChange={(event) => setMessage(event.target.value)} /></label>
        {summary && <label className="flex items-start gap-2.5 text-xs pointer-coarse:min-h-11 pointer-coarse:items-center">
          <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" disabled={busy} checked={withSummary} onChange={(event) => setWithSummary(event.target.checked)} />
          Include the summary
        </label>}
      </>}
      <p className="text-xs text-muted-foreground">{picking === "approve" && open
        ? <>Tells <ThreadName threadId={open.threadId} title={open.title} /> “Approved”, with your message and the summary if you add them, after what it’s doing. Nothing goes to GitHub.</>
        : picking === "send" && open
        ? <>Sends them to <ThreadName threadId={open.threadId} title={open.title} />, after what it’s doing, and asks it to reply with what it changed. Nothing goes to GitHub, and your draft stays as it is.</>
        : "Starts a BB thread in this project to fix them. Your draft stays as it is."}</p>
      <div className="flex flex-wrap gap-2">
        {picking === "approve" && open
          ? <Button size="sm" className={TOUCH_CONTROL} disabled={busy} onClick={() => void approve(open)}>{busy ? spinner : <Icon name="Send" className="size-4" aria-hidden />}Send</Button>
          : picking === "send" && open
          ? <Button size="sm" className={TOUCH_CONTROL} disabled={busy || !chosen.length} onClick={() => void send(open)}>{busy ? spinner : <Icon name="Send" className="size-4" aria-hidden />}Send</Button>
          : <Button size="sm" className={TOUCH_CONTROL} disabled={busy || !chosen.length} onClick={() => void start()}>{busy && spinner}Start thread</Button>}
        <Button size="sm" variant="ghost" className={TOUCH_CONTROL} disabled={busy} onClick={() => setChoosing(null)}>Cancel</Button>
      </div>
    </fieldset> : approvable ? <div className="space-y-2">
      <Button variant="outline" size="sm" className={`max-w-full ${TOUCH_CONTROL}`} onClick={() => choose("approve")}><Icon name="Send" className="size-4" aria-hidden /><span className="flex min-w-0"><span className="shrink-0 whitespace-pre">Send approval to </span><ThreadName threadId={open.threadId} title={open.title} /></span></Button>
      <p className="text-xs text-muted-foreground">Tells it “Approved”, with your message and the summary if you add them, after what it’s doing. Nothing goes to GitHub.</p>
    </div> : comments.length > 0 && (open ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button variant="outline" size="sm" className={`max-w-full ${TOUCH_CONTROL}`} onClick={() => choose("send")}><Icon name="Send" className="size-4" aria-hidden />{/* The button's gap is twice a word space: the label's own space, drawn, spaces the title. */}<span className="flex min-w-0"><span className="shrink-0 whitespace-pre">Send {count} to </span><ThreadName threadId={open.threadId} title={open.title} /></span></Button>
      <span className="text-xs text-muted-foreground">or <button type="button" className={LINK} onClick={() => choose("fix")}>Fix in a new thread</button></span>
    </div> : <Button variant="outline" size="sm" className={TOUCH_CONTROL} onClick={() => choose("fix")}><Icon name="Code" className="size-4" aria-hidden />Fix in a new thread</Button>)}
  </section>;
}
