import { useEffect, useState } from "react";
import { experimental_useSidebarThreads, ThreadTitle, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import { linesOf, type DraftComment } from "../src/draft";
import { useMainThread } from "../lib/main-thread";
import { useKnob } from "../lib/settings";
import { cn } from "../lib/utils";
import { useWorkspace } from "../lib/workspace-context";
import { TOUCH_CONTROL, TOUCH_TARGET } from "./touch";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { InlineCode } from "./ui/inline-code";
import { Textarea } from "./ui/textarea";
import { locationKey } from "./InlineDraft";
import { useDraft } from "./DraftProvider";
import { plainLine } from "./comments/look";
import { isOpen, sentNote, SendWarning, type Choice, type SendWarned } from "./SendNow";

const LINK = `relative rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${TOUCH_TARGET}`;
const plural = (n: number) => `${n} comment${n === 1 ? "" : "s"}`;
/** A thread working now, whose Send waits for its turn to end. */
const BUSY = new Set(["starting", "active", "stopping"]);

/** A thread's title as BB's thread list shows it, or as it was read, where the list doesn't have it. */
export function ThreadName({ threadId, title, wrap = false }: { threadId: string; title: string | null; wrap?: boolean }) {
  const listed = experimental_useSidebarThreads().threads.some((thread) => thread.id === threadId);
  return <span className={cn("inline-block min-w-0 max-w-full align-bottom font-medium text-foreground", wrap ? "line-clamp-2 break-words" : "truncate")}>{listed ? <ThreadTitle threadId={threadId} /> : title ?? "the main thread"}</span>;
}

/**
 * Finish review's Send: the open comments you choose, each with an id, to the review's main thread, the thread that
 * writes the code, named with its machine under the button, after its turn if it's busy, with your message and the
 * summary if you add them, and whether it may push when done; or else a new visible thread. With no open comments, it
 * tells the main thread you approve the diff at `revision`. Someone else's PR, a main thread archived or deleted, or a
 * folder removed warn first: then the warning's choices are the form's only buttons, and the form says where they go.
 */
export function FixHandoff({ targetKey, comments, revision }: { targetKey: string; comments: readonly DraftComment[]; revision: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const sendOn = useKnob("sendToThread");
  const { panel } = useWorkspace();
  // refresh: a Send makes its comments sent, which the draft says at once, as BB's realtime would.
  const { review, draft, refresh, isLocal, ownPr } = useDraft();
  const { thread: main, reload } = useMainThread(targetKey, review);
  const listed = experimental_useSidebarThreads().threads.find((thread) => thread.id === main?.threadId);
  // What the picker is for: sending comments or an approval to the main thread, or a new thread.
  const [choosing, setChoosing] = useState<"send" | "approve" | "fix" | null>(null);
  // The comments you left out; ones added meanwhile are in.
  const [left, setLeft] = useState<string[]>([]);
  // What goes with what you send to the main thread.
  const [message, setMessage] = useState("");
  const [withSummary, setWithSummary] = useState(false);
  // Let it push when done, the review's, as you last set it here; on someone else's PR, asked once before it's on.
  const [letPush, setLetPush] = useState(!!review?.letPush);
  useEffect(() => setLetPush(!!review?.letPush), [review?.letPush]);
  const [askingPush, setAskingPush] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A Send that warned, and what sends it once you choose.
  const [warned, setWarned] = useState<(SendWarned & { retry: (choice: Choice) => void; anyway: string }) | null>(null);
  const [started, setStarted] = useState<{ threadId: string; title: string } | null>(null);
  // An approval's is for the diff it approved.
  const [sent, setSent] = useState<{ threadId: string; title: string | null; note: string; revision?: string } | null>(null);
  // Comments sent, resolved or dismissed don't go again.
  const open = comments.filter(isOpen);
  const chosen = open.filter((comment) => !left.includes(locationKey(comment)));
  const to = sendOn ? main ?? null : null;
  const approval = review?.approvalSent;
  const approved = to && approval?.threadId === to.threadId && approval.revision === revision ? approval : null;
  // What the thread was told: sent from here, or an approval of this diff, sent before, while nothing is open.
  const told = sent ?? (approved && !open.length ? { threadId: approved.threadId, title: approved.title, note: sentNote("sent", approved.title, "your approval") } : null);
  const approvable = !!to && !open.length && !approved && sent?.revision !== revision;
  if (!open.length && !started && !told && !approvable && !warned) return null;
  // An approval's form closes once there's nothing to approve.
  const picking = choosing === "approve" && !approvable ? null : choosing;
  const summary = draft.body.trim();
  // A PR's comments post with Submit, which a Send doesn't change; a local review's never post.
  const posts = review?.kind === "pr";
  const theirs = !isLocal && !ownPr && !review?.feature;
  const waits = !!listed && BUSY.has(listed.status) ? " after its current turn" : "";
  const picked = () => chosen.map(({ file, line, side }) => ({ file, line, side }));
  const extras = () => ({ ...(message.trim() ? { message: message.trim() } : {}), ...(withSummary && summary ? { includeSummary: true } : {}) });
  /** Run a send, showing what it warned, with what sends it, or why it failed. */
  async function attempt(run: (choice?: Choice) => Promise<{ ok: boolean; warning?: string } & Partial<Pick<SendWarned, "offers" | "freshWhere" | "forkFrom" | "choice">> | void>, anyway: string, choice?: Choice) {
    setBusy(true); setError(null);
    try {
      const result = await run(choice);
      if (result && !result.ok && result.warning) setWarned({ warning: result.warning, offers: result.offers ?? ["anyway"], freshWhere: result.freshWhere, forkFrom: result.forkFrom, choice: result.choice, anyway, retry: (next) => void attempt(run, anyway, next) });
      else { setWarned(null); setChoosing(null); }
    } catch (failure) {
      setWarned(null);
      setError(failure instanceof Error ? failure.message : "Couldn’t send to the thread. Try again.");
    } finally { setBusy(false); }
  }
  const start = () => attempt(async (choice) => {
    const result = await rpc.call("startFixThread", { targetKey, comments: picked(), ...choice });
    if (result.ok) setStarted({ threadId: result.threadId, title: result.title });
    return result;
  }, "Start anyway");
  const send = () => attempt(async (choice) => {
    const count = chosen.length;
    const result = await rpc.call("sendToSourceThread", { targetKey, comments: picked(), ...extras(), ...choice });
    if (result.ok) { setSent({ threadId: result.threadId ?? to!.threadId, title: result.title, note: sentNote(result.delivery, result.title, plural(count)) }); reload(); refresh(); }
    return result;
  }, "Send anyway");
  const approve = () => attempt(async (choice) => {
    const result = await rpc.call("sendApprovalToSourceThread", { targetKey, revision, ...extras(), ...choice });
    // With no thread to tell, it's recorded, as you chose.
    if (result.ok) { setSent({ threadId: result.threadId ?? to!.threadId, title: result.title, note: result.recorded ? "Recorded your approval: no thread got it." : sentNote(result.delivery, result.title, "your approval"), revision }); reload(); }
    return result;
  }, "Send anyway");
  async function changeLetPush(next: boolean) {
    setAskingPush(false);
    setLetPush(next);
    try {
      const result = await rpc.call("setLetPush", { targetKey, letPush: next });
      if (!result.ok) throw new Error(result.error);
    } catch (failure) {
      setLetPush(!next);
      toast.error(failure instanceof Error && failure.message ? failure.message : "Couldn’t change Let it push when done.");
    }
  }
  const choose = (what: "send" | "approve" | "fix") => { setChoosing(what); setLeft([]); setMessage(""); setWithSummary(false); setError(null); setWarned(null); setAskingPush(false); };
  const spinner = <Icon name="Loading" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />;
  const name = to && <ThreadName threadId={to.threadId} title={to.title} />;
  // Where what you send goes, said under the form: the main thread, or, with a warning up, where its choices send it.
  const what = picking === "approve" ? "“Approved”, with your message and the summary if you add them," : "them";
  const target = warned?.offers.includes("unarchive") ? <>to {name} once it’s unarchived, or to a fresh thread {warned.freshWhere}</>
    : warned?.offers.includes("fresh") ? <>to a fresh thread it starts {warned.freshWhere}</>
    : <>to {name}{waits}</>;
  return <section aria-label={to ? "Send to the main thread" : "Fix in a new thread"} className="space-y-2">
    {/* A part of Finish, as Open a PR after it is. */}
    <h3 aria-hidden className="px-0.5 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">{to ? "Main thread" : "Fix in a new thread"}</h3>
    {told && <p role="status" className="min-w-0 text-xs text-muted-foreground">{told.note} · <button type="button" className={LINK} onClick={() => navigate.toThread(told.threadId)}>Main thread<span aria-hidden> ↗</span></button></p>}
    {started && <p role="status" className="text-xs text-muted-foreground">Started a thread: <span className="text-foreground">{started.title}</span> · <button type="button" className={LINK} onClick={() => navigate.toThread(started.threadId)}>Go to thread<span aria-hidden> ↗</span></button></p>}
    {error && <p role="alert" className="text-xs text-destructive-text">{error}</p>}
    {warned && <SendWarning warned={warned} busy={busy} anyway={warned.anyway} what={plural(chosen.length)} onChoose={warned.retry} onCancel={() => setWarned(null)} />}
    {picking ? <fieldset className="space-y-2">
      <legend className="mb-2 text-xs font-medium">{picking === "approve" ? "Approval to send" : picking === "send" ? "Comments to send" : "Comments to fix"}</legend>
      {picking !== "approve" && open.map((comment) => {
        const key = locationKey(comment);
        return <label key={key} className="flex items-start gap-2.5 text-xs pointer-coarse:min-h-11 pointer-coarse:items-center">
          <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" disabled={busy} checked={!left.includes(key)} onChange={(event) => setLeft(event.target.checked ? left.filter((k) => k !== key) : [...left, key])} />
          {/* Its first line, as its pill reads it: code as code, without Markdown's marks. */}
          <span className="min-w-0"><span className="font-mono text-[11px]">{comment.file}:{linesOf(comment)}</span> <span className="line-clamp-1 break-words text-muted-foreground"><InlineCode text={plainLine(comment.body)} /></span></span>
        </label>;
      })}
      {picking !== "fix" && to && <>
        <label className="block space-y-1"><span className="text-xs font-medium">Message (optional)</span><Textarea autoFocus rows={3} maxLength={65_000} disabled={busy} value={message} className="min-h-16 bg-background text-sm" onChange={(event) => setMessage(event.target.value)} /></label>
        {summary && <label className="flex items-start gap-2.5 text-xs pointer-coarse:min-h-11 pointer-coarse:items-center">
          <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" disabled={busy} checked={withSummary} onChange={(event) => setWithSummary(event.target.checked)} />
          Include the summary
        </label>}
      </>}
      {picking === "send" && to && <label className="flex items-start gap-2.5 text-xs pointer-coarse:min-h-11 pointer-coarse:items-center">
        {/* On someone else's PR, turning it on asks once first. */}
        <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" disabled={busy} checked={letPush} onChange={(event) => { if (event.target.checked && theirs) setAskingPush(true); else void changeLetPush(event.target.checked); }} />
        Let it push when done
      </label>}
      {askingPush && <div role="alert" className="space-y-2 rounded-lg border border-warning/25 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning-text">
        <p className="flex gap-1.5"><Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span>This is {review?.author ? `@${review.author}’s` : "someone else’s"} PR: a push changes their branch. Leave pushing to them, or let the main thread push anyway?</span></p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className={TOUCH_CONTROL} onClick={() => void changeLetPush(true)}>Let it push</Button>
          <Button size="sm" variant="ghost" className={TOUCH_CONTROL} onClick={() => setAskingPush(false)}>Keep it off</Button>
        </div>
      </div>}
      <p className="text-xs text-muted-foreground">{picking !== "fix" && to
        ? <>Sends {what} {target}{picking === "send" ? <>, each with an id it reports on. {letPush ? "It may push when it’s done." : "It won’t push until you say."}</> : "."} Nothing goes to GitHub{posts ? ", and your draft stays as it is" : ""}.</>
        : `Starts a BB thread in this project to fix them.${posts ? " Your draft stays as it is." : ""}`}</p>
      {/* With a warning up, its choices are the only way on. */}
      {!warned && <div className="flex flex-wrap gap-2">
        {picking === "approve" && to
          ? <Button size="sm" className={TOUCH_CONTROL} disabled={busy} onClick={() => void approve()}>{busy ? spinner : <Icon name="Send" className="size-4" aria-hidden />}Send</Button>
          : picking === "send" && to
          ? <Button size="sm" className={TOUCH_CONTROL} disabled={busy || !chosen.length} onClick={() => void send()}>{busy ? spinner : <Icon name="Send" className="size-4" aria-hidden />}Send</Button>
          : <Button size="sm" className={TOUCH_CONTROL} disabled={busy || !chosen.length} onClick={() => void start()}>{busy && spinner}Start thread</Button>}
        <Button size="sm" variant="ghost" className={TOUCH_CONTROL} disabled={busy} onClick={() => setChoosing(null)}>Cancel</Button>
      </div>}
    </fieldset> : warned ? null : approvable ? <div className="space-y-2">
      <Button variant="outline" size="sm" className={`max-w-full ${TOUCH_CONTROL}`} onClick={() => choose("approve")}><Icon name="Send" className="size-4" aria-hidden />Send approval to main thread</Button>
      <p className="text-xs text-muted-foreground">Tells it “Approved”, with your message and the summary if you add them{waits}. Nothing goes to GitHub.</p>
    </div> : open.length > 0 && (to ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button variant="outline" size="sm" className={`max-w-full ${TOUCH_CONTROL}`} onClick={() => choose("send")}><Icon name="Send" className="size-4" aria-hidden />Send {open.length} to main thread</Button>
      <span className="text-xs text-muted-foreground">or <button type="button" className={LINK} onClick={() => choose("fix")}>Fix in a new thread</button></span>
    </div> : <Button variant="outline" size="sm" className={TOUCH_CONTROL} onClick={() => choose("fix")}><Icon name="Code" className="size-4" aria-hidden />Fix in a new thread</Button>)}
    {/* Which thread that is, and where: the review and its main thread can share a name. */}
    {to && !picking && <p className="text-xs text-muted-foreground">
      {to.state === "gone" ? <>The main thread was deleted: Send starts a fresh thread. </>
        : <>{name}{to.machine && <> · {to.machine}</>}{to.state === "archived" ? <>, archived: Send offers to unarchive it or start a fresh thread. </> : " · "}</>}
      <button type="button" className={LINK} onClick={() => panel.open("main")}>Change main thread</button>
    </p>}
  </section>;
}
