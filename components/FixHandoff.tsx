import { useEffect, useState } from "react";
import { experimental_useSidebarThreads, ThreadTitle, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import type { SourceThread } from "../src/fix-handoff";
import { linesOf, type DraftComment } from "../src/draft";
import { useKnob } from "../lib/settings";
import { TOUCH_CONTROL, TOUCH_TARGET } from "./touch";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
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
 * change, while it's open and Send to thread is on, or else a new visible thread.
 */
export function FixHandoff({ targetKey, comments }: { targetKey: string; comments: readonly DraftComment[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const sendOn = useKnob("sendToThread");
  const sourceId = useDraft().review?.sourceThreadId ?? null;
  const [source, setSource] = useState<SourceThread | null>(null);
  // What the picker is for: sending to the source thread, or a new thread.
  const [choosing, setChoosing] = useState<"send" | "fix" | null>(null);
  // The comments you left out; ones added meanwhile are in.
  const [left, setLeft] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ threadId: string; title: string } | null>(null);
  const [sent, setSent] = useState<{ threadId: string; title: string | null; delivery: "sent" | "queued" } | null>(null);
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
  if (!comments.length && !started && !sent) return null;
  const picked = () => chosen.map(({ file, line, side }) => ({ file, line, side }));
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
      const result = await rpc.call("sendToSourceThread", { targetKey, comments: picked() });
      setSent({ threadId: to.threadId, title: result.title, delivery: result.delivery });
      setChoosing(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn’t send to the thread. Try again.");
    } finally { setBusy(false); }
  }
  const choose = (what: "send" | "fix") => { setChoosing(what); setLeft([]); setError(null); };
  const count = `${comments.length} comment${comments.length === 1 ? "" : "s"}`;
  return <section aria-label={open ? "Send to thread" : "Fix in a new thread"} className="space-y-2 border-t border-border pt-3">
    {sent && <p role="status" className="min-w-0 text-xs text-muted-foreground">{sent.delivery === "queued" ? "Queued in" : "Sent to"} <ThreadName threadId={sent.threadId} title={sent.title} /> · <button type="button" className={LINK} onClick={() => navigate.toThread(sent.threadId)}>Open</button></p>}
    {started && <p role="status" className="text-xs text-muted-foreground">Started a thread: <span className="text-foreground">{started.title}</span> · <button type="button" className={LINK} onClick={() => navigate.toThread(started.threadId)}>Open</button></p>}
    {error && <p role="alert" className="text-xs text-destructive-text">{error}</p>}
    {sendOn && source && source.state !== "open" && <p className="text-xs text-muted-foreground">{source.state === "archived" ? `${source.title ?? "The thread that made the change"} is archived.` : "The thread that made the change was deleted."}</p>}
    {choosing ? <fieldset className="space-y-2">
      <legend className="mb-2 text-xs font-medium">{choosing === "send" ? "Comments to send" : "Comments to fix"}</legend>
      {comments.map((comment) => {
        const key = locationKey(comment);
        return <label key={key} className="flex items-start gap-2.5 text-xs pointer-coarse:min-h-11 pointer-coarse:items-center">
          <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" disabled={busy} checked={!left.includes(key)} onChange={(event) => setLeft(event.target.checked ? left.filter((k) => k !== key) : [...left, key])} />
          <span className="min-w-0"><span className="font-mono text-[11px]">{comment.file}:{linesOf(comment)}</span> <span className="line-clamp-1 break-words text-muted-foreground">{comment.body}</span></span>
        </label>;
      })}
      <p className="text-xs text-muted-foreground">{choosing === "send" && open
        ? <>Sends them to <ThreadName threadId={open.threadId} title={open.title} />, after what it’s doing, and asks it to reply with what it changed. Nothing goes to GitHub, and your draft stays as it is.</>
        : "Starts a BB thread in this project to fix them. Your draft stays as it is."}</p>
      <div className="flex flex-wrap gap-2">
        {choosing === "send" && open
          ? <Button size="sm" className={TOUCH_CONTROL} disabled={busy || !chosen.length} onClick={() => void send(open)}>{busy ? <Icon name="Loading" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Icon name="Send" className="size-4" aria-hidden />}Send</Button>
          : <Button size="sm" className={TOUCH_CONTROL} disabled={busy || !chosen.length} onClick={() => void start()}>{busy && <Icon name="Loading" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}Start thread</Button>}
        <Button size="sm" variant="ghost" className={TOUCH_CONTROL} disabled={busy} onClick={() => setChoosing(null)}>Cancel</Button>
      </div>
    </fieldset> : comments.length > 0 && (open ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button variant="outline" size="sm" className={`max-w-full ${TOUCH_CONTROL}`} onClick={() => choose("send")}><Icon name="Send" className="size-4" aria-hidden /><span className="shrink-0">Send {count} to</span> <ThreadName threadId={open.threadId} title={open.title} /></Button>
      <span className="text-xs text-muted-foreground">or <button type="button" className={LINK} onClick={() => choose("fix")}>Fix in a new thread</button></span>
    </div> : <Button variant="outline" size="sm" className={TOUCH_CONTROL} onClick={() => choose("fix")}><Icon name="Code" className="size-4" aria-hidden />Fix in a new thread</Button>)}
  </section>;
}
