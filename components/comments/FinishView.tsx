import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import { SUMMARY_AT, VERDICT_LABEL, verdictPicked, type Verdict } from "../../src/draft";
import type { CommentFilter, CommentItem } from "../../lib/comments";
import { rushedDoubt, unviewedDoubt } from "../../lib/approve-guard";
import { readOf } from "../../lib/agent-coverage";
import { readDraftRecovery } from "../../lib/draft-recovery";
import { useKnob } from "../../lib/settings";
import { needsOrder, reviewState, type ReviewItem } from "../../lib/review-state";
import { reviewIdentity } from "../../lib/review-identity";
import { pushAnywayOffered, pushFlagText, pushTarget } from "../../lib/push";
import { Marked, Mono, updateThenClear } from "../shell/PushNotices";
import { statusWhy } from "../../lib/status-line";
import { cn } from "../../lib/utils";
import { NOT_PUSHED_PAGE, useWorkspace } from "../../lib/workspace-context";
import { useDraft } from "../DraftProvider";
import { FixHandoff, LINK } from "../FixHandoff";
import { ReviewerNotes } from "../ReviewerNotes";
import { SummaryCard } from "../SummaryCard";
import { age, timeAgo } from "../time-ago";
import { TOUCH_CONTROL, TOUCH_TARGET } from "../touch";
import { Button, buttonVariants } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon, type IconName } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";
import { MetaLine } from "../MetaLine";
import { Clamped } from "./CommentCard";
import { notSubmitted } from "./look";
import { MoveToSummary } from "./MoveToSummary";
import { focusComments } from "./CommentsView";
import { updateComments, useComments } from "./store";

const OWN_PR = "This is your PR, so GitHub allows only a Comment review.";
const RECEIPT_LABEL: Record<Verdict, string> = { APPROVE: "Approved", REQUEST_CHANGES: "Changes requested", COMMENT: "Commented" };
const VERDICTS = [
  ["APPROVE", "aria-pressed:bg-success/15 aria-pressed:text-diff-added aria-pressed:ring-success/30 aria-pressed:hover:bg-success/20"],
  ["COMMENT", "aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:ring-primary/30 aria-pressed:hover:bg-primary/20"],
  ["REQUEST_CHANGES", "aria-pressed:bg-warning/15 aria-pressed:text-warning-text aria-pressed:ring-warning/30 aria-pressed:hover:bg-warning/20"],
] as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A primary button that's busy: aria-disabled, so it keeps the focus, and drawn as a disabled one (ui/button). */
const BUSY = "aria-disabled:pointer-events-none aria-disabled:bg-muted/60 aria-disabled:text-subtle-foreground aria-disabled:shadow-none";

/**
 * Finish review, the side panel's view for it: the summary, the verdict (with the agent's suggestion, Use as draft and
 * Request what's left), what goes to GitHub, what stays in BB, and Submit, with each doubt listed beside its fix. After
 * you submit, the receipt offers the next review that needs you. A local review hands its comments to a new thread
 * instead; a closed PR keeps its unsubmitted draft to read.
 */
export function FinishView({ shown, revision }: {
  /** Finish is the panel's view. */
  shown: boolean;
  /** The review revision the page shows, for draft changes. */
  revision: string;
}) {
  const api = useWorkspace();
  const { targetKey, review } = api;
  const d = useDraft();
  const items = useComments(targetKey, "items");
  const isPr = review.kind === "pr";
  const notes = usePrivateNotes(targetKey, shown);
  const plan = usePushPlan();
  // What the last Submit here sent, for its receipt.
  const [sent, setSent] = useState<{ comments: number; at: number } | null>(null);
  const submit = (confirmed = false, choice?: "anyway" | "comment") => {
    if (confirmed || !(d.doubts.length || d.approvingBlocked)) setSent({ comments: d.posting.length, at: Date.now() });
    void d.submit(confirmed, choice);
  };
  // It didn't go: there's no receipt to show.
  useEffect(() => { if (d.status.error) setSent(null); }, [d.status.error]);
  const openList = (filter: CommentFilter, id: string | null = null) => {
    updateComments(targetKey, { filter, expanded: id });
    api.panel.open("comments");
    focusComments(targetKey);
  };

  // The receipt of a review sent from here; one sent earlier is a line above the next one's draft.
  const body = !d.loaded || d.loadError ? null
    : d.closed ? <Archived />
    : d.completed && sent ? <Receipt sent={sent} />
    : null;
  // The panel's header names what shows, as Comments' foot does.
  const title = !body ? null : d.closed ? "Archived review" : "Review submitted";
  useEffect(() => updateComments(targetKey, { finishTitle: title }), [targetKey, title]);
  return (
    <div hidden={!shown} className={cn("flex min-h-0 flex-1 flex-col", !shown && "hidden")}>
      {d.loadError ? <div role="alert" className="space-y-3 p-3 text-sm"><p>Couldn’t load your draft. Editing is paused to protect it.</p><Button variant="outline" className={TOUCH_CONTROL} onClick={() => void d.load()}>Retry draft</Button></div>
        : !d.loaded ? <p role="status" className="p-3 text-sm text-muted-foreground">Loading draft…</p>
        : body ? <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">{body}{notes.show && <PrivateNotes targetKey={targetKey} />}</div>
        : <section aria-label="Review draft" className="flex min-h-0 flex-1 flex-col [@media(max-height:640px)]:overflow-y-auto">
          {/* On short screens the draft and its foot scroll together, so the foot doesn't crowd out the draft. */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 [@media(max-height:640px)]:flex-none [@media(max-height:640px)]:overflow-visible">
            {d.submittedVerdict && <LastReview />}
            <span role="status" className={cn("flex items-center gap-1.5 text-xs", d.status.error ? "text-destructive-text" : "text-muted-foreground")}>{d.status.error ? <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden /> : d.status.saving ? <Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Icon name="CircleCheck" className="size-3.5 text-diff-added" aria-hidden />}{d.status.error ?? (d.status.saving ? "Saving…" : "Draft saved")}</span>
            <Part title={isPr ? "Summary · posted with your verdict" : "Summary"}>
              <SummaryCard cardRef={d.summaryRef} draft={d.draft} discussion={d.summaryDiscussion} editable={d.editable} busy={d.busy} writing={d.writing && !d.onSummary} composer={d.summaryComposer} isLocal={d.isLocal} chat={d.chat}
                changedWhileEditing={d.onSummary && !d.asking && d.summaryBase.current !== null && d.summaryBase.current !== d.draft.body}
                onEdit={() => d.openComposer(SUMMARY_AT, false)} onAsk={() => d.openComposer(SUMMARY_AT, false, true)} onRemove={() => void d.saveSummary("", d.revisionRef.current)}
                onUndo={() => void d.undo(SUMMARY_AT)} onRequest={(text) => void d.requestSummary(text)} />
            </Part>
            {isPr && <Verdicts revision={revision} />}
            {isPr ? <GoesToGitHub items={items} replyDrafts={items.filter((item) => item.kind === "thread" && item.replyDraft).length} onList={openList} />
              : <Part title="Stays in BB"><p className="text-sm text-muted-foreground">{d.hint}</p>{notes.show && <PrivateNotes targetKey={targetKey} />}</Part>}
            {(d.isLocal || d.ownPr || api.mainThread) && <FixHandoff targetKey={targetKey} comments={d.sortedComments} revision={revision} />}
            <Push plan={plan} />
            {d.isLocal && <OpenPr plan={plan} />}
            <AgentActivity />
            {isPr && notes.show && <Part title="Stays in BB"><PrivateNotes targetKey={targetKey} /></Part>}
          </div>
          {!d.isLocal && <SubmitFoot onSubmit={submit} />}
        </section>}
    </div>
  );
}

/** A part of Finish, under its heading. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  const [main, rest] = title.split(" · ");
  return <section className="space-y-2">
    <h3 className="px-0.5 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">{main}{rest && <span className="font-normal normal-case tracking-normal"> · {rest}</span>}</h3>
    {children}
  </section>;
}

/** What Push offers a local review (src/open-pr.ts pushPlan). */
type PushPlan = { openable: boolean; onGithub: boolean; pr: boolean; compare?: string };

/** The review's Push plan, read again as its Push moves on: undefined while it's read, null for none or unread. */
function usePushPlan(): PushPlan | null | undefined {
  const { targetKey, review } = useWorkspace();
  const rpc = useRpc<typeof rpcContract>();
  const [plan, setPlan] = useState<PushPlan | null>();
  const local = review.kind === "ref" && !!review.feature?.repo;
  const state = review.push?.state;
  useEffect(() => {
    if (!local) return;
    let cancelled = false;
    rpc.call("pushPlan", { targetKey }).then((read) => { if (!cancelled) setPlan(read); }, () => { if (!cancelled) setPlan(null); });
    return () => { cancelled = true; };
  }, [rpc, targetKey, local, state]);
  return local ? plan : null;
}

/**
 * Push, on a local review of a branch in a GitHub repo, while Send to thread is on (src/push.ts): the main thread commits
 * what you reviewed, the review checks the commit, and the thread pushes exactly it. It shows where that stands:
 * waiting on the commit, the commit not what you reviewed (Update first, or Push anyway), pushing, pushed, or flagged.
 * A local review whose branch has no PR, while the review agent may act, offers Push and open PR, with Push only: once
 * it's pushed, the review agent drafts the PR. With the agent drafting only, a push links to GitHub to open one.
 */
function Push({ plan }: { plan: PushPlan | null | undefined }) {
  const { targetKey, review, reload, go, panel } = useWorkspace();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const sendOn = useKnob("sendToThread");
  const acts = useKnob("reviewAgentActs");
  const [busy, setBusy] = useState<"push" | "anyway" | "update" | "dismiss" | null>(null);
  // What went wrong, or that there was nothing to push.
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);
  // A local review's folder, or on your PR, the thread fixing it, a fixer's or the folder it became a PR from.
  const target = pushTarget(review);
  if (!sendOn || typeof target === "string") return null;
  const who = target.fixer ? "the fixer" : "the main thread";
  const run = review.push ?? null;
  const sha = run?.sha ? run.sha.slice(0, 7) : "";
  // Push and open PR, unless the agent was asked already, or couldn't be, when Open PR asks it again.
  const both = acts && !!plan?.openable && !plan.pr && run?.thenOpenPr !== "asked" && run?.thenOpenPr !== "failed";
  async function act(what: NonNullable<typeof busy>, call: () => Promise<{ ok: boolean; error?: string; note?: string }>, done?: string) {
    if (busy) return;
    setBusy(what);
    setSaid(null);
    try {
      const result = await call();
      if (!result.ok) setSaid({ text: result.error ?? "Something went wrong. Try again.", error: true });
      else if (result.note) setSaid({ text: result.note, error: false });
      else if (done) toast.success(done);
      await reload();
    } catch (e) {
      setSaid({ text: e instanceof Error ? e.message : "Something went wrong. Try again.", error: true });
    } finally { setBusy(null); }
  }
  // Push anyway goes on the warning shown: its commit, when it has one.
  const push = (force = false, thenOpenPr = false) => act(force ? "anyway" : "push", () => rpc.call("push", { targetKey, ...thenOpenPr ? { thenOpenPr } : {}, ...force && run ? { force, at: run.at, ...run.sha ? { sha: run.sha } : {} } : {} }));
  const dismiss = () => act("dismiss", () => rpc.call("dismissPush", { targetKey }));
  // On your PR, what you review before it's pushed is Not pushed yet: Update first opens it.
  const update = () => target.pr ? act("update", async () => {
    go(NOT_PUSHED_PAGE);
    return rpc.call("dismissPush", { targetKey });
  }) : act("update", () => updateThenClear(rpc, targetKey), "Updated. Review what changed, then Push.");
  const spinner = (on: boolean, icon: IconName) => <Icon name={on ? "Loading" : icon} className={cn("size-4", on && "animate-spin motion-reduce:animate-none")} aria-hidden />;
  const pushButton = (label: string, thenOpenPr = false) => <Button variant={thenOpenPr ? "default" : "outline"} size="sm" className={cn("gap-1.5", TOUCH_CONTROL, BUSY)} aria-disabled={!!busy || undefined} onClick={() => void push(false, thenOpenPr)}>
    {spinner(busy === "push", "ArrowUp")}{busy === "push" ? "Asking the main thread…" : label}
  </Button>;
  const quiet = (label: string, onClick: () => void) => <Button variant="ghost" size="sm" className={cn("text-muted-foreground hover:text-foreground", TOUCH_CONTROL, BUSY)} aria-disabled={!!busy || undefined} onClick={onClick}>{label}</Button>;
  const cancel = (label = "Cancel") => quiet(label, () => void dismiss());
  const updateButton = (label: string, filled: boolean) => <Button size="sm" variant={filled ? "default" : "outline"} className={cn("gap-1.5", !filled && "text-foreground", TOUCH_CONTROL, BUSY)} aria-disabled={!!busy || undefined} onClick={() => void update()}>{spinner(busy === "update", "ArrowReloadHorizontal")}{label}</Button>;
  const branch = <Mono text={run?.head ?? target.head} />;
  const flag = pushFlagText(run);
  const secrets = new Set(run?.secrets ?? []);
  const files = [...new Set([...run?.files ?? [], ...secrets])];
  return <Part title="Push">
    {run?.state === "committing" ? <div className="space-y-2">
      <p role="status" className="flex gap-1.5 text-sm text-muted-foreground"><Icon name="Loading" className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />Waiting for {who} to commit. The review checks the commit before anything is pushed.</p>
      {cancel()}
    </div>
    : run?.state === "mismatch" ? <div role="alert" className="space-y-2 rounded-lg border border-warning/25 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning-text">
      <p><span className="font-medium">Not pushed.</span> {run.warning ? <Marked text={run.warning} /> : <><Mono text={sha} /> isn’t what you reviewed.</>}</p>
      {files.length > 0 && <ul className="list-disc space-y-0.5 pl-5">{files.slice(0, 5).map((file) => <li key={file}><Mono text={file} />{secrets.has(file) && <span className="font-medium"> · may hold secrets</span>}</li>)}{files.length > 5 && <li>and {files.length - 5} more</li>}</ul>}
      <div className="flex flex-wrap gap-2">
        {/* GitHub being ahead isn't something Update fixes; a commit the check couldn't place has nothing to push anyway. */}
        {!(run.behind && !files.length) && updateButton("Update first", true)}
        {pushAnywayOffered(run) && <Button size="sm" variant="outline" className={cn("gap-1.5 text-foreground", TOUCH_CONTROL, BUSY)} aria-disabled={!!busy || undefined} onClick={() => void push(true)}>{spinner(busy === "anyway", "ArrowUp")}Push anyway</Button>}
        {cancel()}
      </div>
    </div>
    : run?.state === "pushing" ? <div className="space-y-2">
      <p role="status" className="flex gap-1.5 text-sm text-muted-foreground"><Icon name="Loading" className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /><span>Pushing <Mono text={sha} /> to {branch}. {run.thenOpenPr === true ? "Then the review agent drafts the PR." : `The review checks GitHub when ${who} finishes.`}</span></p>
      {cancel("Stop waiting")}
    </div>
    // The strip under the band says it as it happens; here it's a status, so it isn't said twice.
    : flag ? <div role="status" className={cn("space-y-2 rounded-lg border p-2.5 text-xs leading-relaxed", run?.flag === "unrequested" ? "border-border bg-muted/40 text-foreground" : "border-warning/25 bg-warning/10 text-warning-text")}>
      <p><Marked text={flag} /></p>
      <div className="flex flex-wrap gap-2">
        {run?.flag === "unrequested" ? !target.pr && updateButton("Update", false) : <>
          {pushButton("Push again")}
          <Button variant="outline" size="sm" className={cn("text-foreground", TOUCH_CONTROL)} onClick={() => navigate.toThread(run!.threadId)}>Main thread<Icon name="ArrowUpRight" className="size-3.5" aria-hidden /></Button>
        </>}
        {cancel("Got it")}
      </div>
    </div>
    : <>
      {run?.state === "pushed" ? <p role="status" className="flex gap-1.5 text-sm"><Icon name="CircleCheck" className="mt-0.5 size-4 shrink-0 text-diff-added" aria-hidden />{run.thenOpenPr === "asked"
        ? <span>Pushed <Mono text={sha} />. The review agent is drafting the PR; post it from its chat. · <button type="button" className={LINK} onClick={() => panel.open("agent")}>Review agent</button></span>
        : <span>Pushed <Mono text={sha} /> to {branch}{timeAgo(run.at) && <span className="text-muted-foreground"> · {timeAgo(run.at)}</span>}
          {/* With the agent drafting only, GitHub opens the PR. */}
          {!acts && plan?.openable && !plan.pr && plan.compare && <> · <UrlLink href={plan.compare} title="Go to GitHub to open a PR" className={LINK}>Open a PR on GitHub<span aria-hidden> ↗</span></UrlLink></>}</span>}</p>
        : <p className="text-sm text-muted-foreground">{target.fixer ? "The fixer" : "The main thread"} commits what you reviewed{target.pr ? " in Not pushed yet" : ""}, the review checks it, then it’s pushed to {branch}. Never forced.</p>}
      {run?.state === "pushed" && run.thenOpenPr === "failed" && <p role="alert" className="flex gap-1.5 text-xs text-destructive-text"><Icon name="AlertCircle" className="mt-0.5 size-3.5 shrink-0" aria-hidden />Couldn’t ask the review agent to draft the PR: {run.openPrError} Open PR asks it again.</p>}
      {both ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {pushButton("Push and open PR", true)}
        <span className="text-xs text-muted-foreground">or <button type="button" className={LINK} aria-disabled={!!busy || undefined} onClick={() => void push()}>Push only</button></span>
      </div> : pushButton("Push")}
    </>}
    {said?.error && <p role="alert" className="flex gap-1.5 text-xs text-destructive-text"><Icon name="AlertCircle" className="mt-0.5 size-3.5 shrink-0" aria-hidden />{said.text}</p>}
    {said && !said.error && <p role="status" className="flex gap-1.5 text-xs text-muted-foreground"><Icon name="Info" className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span><Marked text={said.text} /></span></p>}
  </Part>;
}

/**
 * Open PR, on a local review of a branch in a GitHub repo, while Settings lets the review agent act: it drafts the PR's
 * title and description, shown in the Post form in its chat, whose click opens it. The server says when the branch
 * needs Push first. Beside Push, it's Push and open PR there, and on its own only for a branch on GitHub with no PR.
 */
function OpenPr({ plan }: { plan: PushPlan | null | undefined }) {
  const { targetKey, review, panel } = useWorkspace();
  const rpc = useRpc<typeof rpcContract>();
  const acts = useKnob("reviewAgentActs");
  const sendOn = useKnob("sendToThread");
  const [busy, setBusy] = useState(false);
  // What went wrong, or what has to happen first, as pushing the branch: an ordinary "not yet", said as such.
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);
  const feature = review.kind === "ref" ? review.feature : null;
  if (!acts || !feature?.repo || feature.prReview) return null;
  // Push shows, as it does (Push), with its plan: unread, Open PR shows as it would.
  const beside = sendOn && typeof pushTarget(review) !== "string";
  if (beside && (plan === undefined || plan && !(plan.openable && plan.onGithub && !plan.pr && review.push?.thenOpenPr !== "asked"))) return null;
  const setError = (text: string) => setSaid({ text, error: true });
  async function open() {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    try {
      const result = await rpc.call("openPr", { targetKey });
      if (!result.ok) setSaid(result.note ? { text: result.note, error: false } : { text: result.error ?? "Couldn’t ask the review agent. Try again.", error: true });
      else if (result.note) toast.info(result.note);
      else panel.open("agent");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t ask the review agent. Try again.");
    } finally { setBusy(false); }
  }
  return <Part title="Open a PR">
    <p className="text-sm text-muted-foreground">The review agent drafts a PR from <Mono text={feature.branch} /> in <Mono text={feature.repo} />, and shows you its title and description before it opens.</p>
    <Button variant="outline" size="sm" className={cn("gap-1.5", TOUCH_CONTROL, BUSY)} aria-disabled={busy || undefined} onClick={() => void open()}>
      <Icon name={busy ? "Loading" : "GitPullRequest"} className={cn("size-4", busy && "animate-spin motion-reduce:animate-none")} aria-hidden />
      {busy ? "Asking the agent…" : "Open PR"}
    </Button>
    {said?.error && <p role="alert" className="flex gap-1.5 text-xs text-destructive-text"><Icon name="AlertCircle" className="mt-0.5 size-3.5 shrink-0" aria-hidden />{said.text}</p>}
    {said && !said.error && <p role="status" className="flex gap-1.5 text-xs text-muted-foreground"><Icon name="Info" className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span><Marked text={said.text} /></span></p>}
  </Part>;
}

/** The verdict, the agent's suggestion with Switch to it, and its two ways into the draft: Use as draft and Request what's left. */
function Verdicts({ revision }: { revision: string }) {
  const { targetKey, openFinish } = useWorkspace();
  const d = useDraft();
  const rpc = useRpc<typeof rpcContract>();
  const feedback = useComments(targetKey, "feedback");
  const ownPrId = useId();
  const [busy, setBusy] = useState<"suggested" | "remaining" | null>(null);
  const [confirming, setConfirming] = useState<"suggested" | "remaining" | null>(null);
  const run = feedback?.run ?? null;
  // Blocking feedback the agent's check says isn't done yet.
  const left = !!feedback?.items.some((item) => !item.nonBlocking && item.assessment && item.assessment.verdict !== "addressed");
  // The agent's summary to use as yours, or its word on where the PR stands: readable here, whatever your summary says.
  const said = feedback?.suggestionInDraft ? "" : (run?.suggestedBody || run?.summary || "").trim();
  async function apply(mode: "suggested" | "remaining") {
    const result = await rpc.call("useSuggestedVerdict", { targetKey, mode, ...(revision ? { revision } : {}) });
    if (!result.ok) return void toast.error(result.error ?? "Couldn’t update the draft.");
    openFinish(true);
    toast.success("Draft updated — review it before submitting.");
  }
  // A summary you wrote, saved or still unsaved in this tab, is replaced only once you say so.
  async function suggest(mode: "suggested" | "remaining") {
    setBusy(mode);
    try {
      const { draft } = await rpc.call("getDraft", { targetKey });
      const recovery = readDraftRecovery(targetKey);
      const saved = (draft?.body ?? "").trim();
      const unsaved = (recovery.composer?.summary && !recovery.composer.asking ? recovery.composer.body : recovery.summary?.body ?? "").trim();
      if ((unsaved && unsaved !== saved) || (saved && draft.bodyAuthor !== "agent")) setConfirming(mode);
      else await apply(mode);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally { setBusy(null); }
  }
  const replace = () => {
    if (!confirming) return;
    const mode = confirming;
    setConfirming(null);
    setBusy(mode);
    void apply(mode).finally(() => setBusy(null));
  };
  const suggested = d.suggested;
  // What the agent says it didn't check, while Finish review shows what it checked.
  const unchecked = d.agentCoverage ? d.draft.unchecked ?? [] : [];
  // With it on, the suggestion stays with what the agent read once you've picked it.
  const checked = !!d.agentCoverage && !!suggested && !(d.ownPr && suggested !== "COMMENT");
  return (
    <section className="space-y-2">
      <h3 className="px-0.5 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Verdict</h3>
      <div role="group" aria-label="Review verdict" className="flex max-w-full flex-wrap gap-0.5 rounded-lg bg-muted/40 p-1 ring-1 ring-inset ring-border">
        {VERDICTS.map(([verdict, pressed]) => <Button key={verdict} type="button" variant="ghost" size="sm" disabled={d.busy || d.ownPr && verdict !== "COMMENT"} {...(d.ownPr && verdict !== "COMMENT" ? { title: OWN_PR, "aria-describedby": ownPrId } : {})} aria-pressed={d.draft.verdict === verdict} aria-label={suggested === verdict ? `${VERDICT_LABEL[verdict]}, suggested by the agent` : undefined} className={cn("relative h-8 grow basis-auto whitespace-nowrap px-2 text-xs text-muted-foreground ring-1 ring-inset ring-transparent aria-pressed:shadow-xs", TOUCH_CONTROL, suggested === verdict && "pr-4", pressed)} onClick={() => d.chooseVerdict(verdict)}>
          {VERDICT_LABEL[verdict]}{suggested === verdict && <span aria-hidden title="Suggested by the agent" className="absolute right-1 top-1 flex"><Icon name="Sparkles" className="size-2.5 text-(--ansi-13)" /></span>}
        </Button>)}
      </div>
      {d.ownPr && <p id={ownPrId} className="text-xs text-muted-foreground">{OWN_PR}</p>}
      {(suggested && (suggested !== d.draft.verdict || !verdictPicked(d.draft)) && !(d.ownPr && suggested !== "COMMENT") || run && (run.suggestedVerdict || left || said) || checked || unchecked.length > 0) && (
        <section aria-label="Agent’s suggestion" className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg bg-(--ansi-13)/5 px-2.5 py-2">
          <p className="flex min-w-0 flex-1 basis-40 items-center gap-1.5 text-xs text-muted-foreground"><Icon name="Sparkles" className="size-3.5 shrink-0 text-(--ansi-13)" aria-hidden />
            {suggested && !(d.ownPr && suggested !== "COMMENT") ? `Agent suggests ${VERDICT_LABEL[suggested]}` : run?.suggestedVerdict ? `Agent suggests ${VERDICT_LABEL[run.suggestedVerdict]}` : left ? "The agent found open items" : "Agent’s check"}
          </p>
          {suggested && suggested !== d.draft.verdict && !d.ownPr && d.editable && <Button size="sm" variant="outline" className={cn("h-7 px-2 text-xs", TOUCH_CONTROL)} disabled={d.busy} onClick={() => d.chooseVerdict(suggested)}>Switch to {VERDICT_LABEL[suggested]}</Button>}
          {d.agentCoverage && d.agentCoverage.total > 0 && <MetaLine className="basis-full text-xs text-muted-foreground" items={[`Read ${readOf(d.agentCoverage)}`]} />}
          {unchecked.length > 0 && <Unchecked items={unchecked} />}
          {said && <div className="min-w-0 basis-full"><Clamped body={said} link /></div>}
          {run && (run.suggestedVerdict || left) && <span className="flex flex-wrap gap-1.5">
            {feedback?.suggestionInDraft
              ? <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="CircleCheck" className="size-3.5 text-diff-added" aria-hidden />In your draft</span>
              : run.suggestedVerdict && <Button size="sm" variant="outline" className={cn("h-7 px-2 text-xs", TOUCH_CONTROL)} disabled={!!busy || !d.editable} onClick={() => void suggest("suggested")}>Use as draft</Button>}
            {left && <Button size="sm" variant="outline" className={cn("h-7 px-2 text-xs", TOUCH_CONTROL)} disabled={!!busy || !d.editable} onClick={() => void suggest("remaining")}>Request what’s left</Button>}
          </span>}
        </section>
      )}
      <Dialog open={!!confirming} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace your summary?</DialogTitle>
            <DialogDescription>The agent’s draft replaces the review summary you wrote.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button variant="outline" className={TOUCH_CONTROL} onClick={() => setConfirming(null)}>Keep mine</Button>
            <Button className={TOUCH_CONTROL} onClick={replace}>Replace summary</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** What the agent says it didn't read or run, folded under its suggestion. It stays in BB. */
function Unchecked({ items }: { items: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return <div className="min-w-0 basis-full">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn("flex min-h-7 items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground", TOUCH_CONTROL)}>
      What it didn’t check<Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3" aria-hidden />
    </button>
    {open && <ul className="list-disc space-y-0.5 pb-1 pl-5 text-xs text-muted-foreground">{items.slice(0, 5).map((item, index) => <li key={index}><InlineCode text={item} /></li>)}</ul>}
  </div>;
}

/** One line of what goes to GitHub, or of what holds it back, with where to see it or fix it. */
function Row({ icon, tone = "neutral", children, action }: { icon: ReactNode; tone?: "neutral" | "warning"; children: ReactNode; action?: ReactNode }) {
  return <li className={cn("flex min-h-11 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm", tone === "warning" ? "border border-warning/30 bg-warning/10 text-warning-text" : notSubmitted("yours"), tone === "neutral" && "border-l-primary/60 bg-card")}>
    {icon}
    <div className="min-w-0 flex-1">{children}</div>
    {action}
  </li>;
}

/**
 * Goes to GitHub: the comments that post and their severities, who wrote them, what holds Submit back, and the reply
 * drafts that post on their own. On your own change, those sent to the main thread, resolved or dismissed don't post.
 */
function GoesToGitHub({ items, replyDrafts, onList }: { items: readonly CommentItem[]; replyDrafts: number; onList: (filter: CommentFilter, id?: string | null) => void }) {
  const d = useDraft();
  const { reveal, showLocation } = useWorkspace();
  const comments = d.posting;
  // Sent to fix from your own change, resolved or dismissed: they stay in BB. Those not on GitHub yet go with Send.
  const held = d.draft.comments.length - comments.length - d.notOnGithub;
  const agent = comments.filter((comment) => comment.author === "agent").length;
  const older = items.filter((item) => item.kind === "draft" && item.state === "older-diff" && item.posts);
  // As MoveToSummary offers it.
  const movable = useKnob("moveToSummary") && d.editable;
  const blocking = items.find((item) => item.kind === "draft" && item.posts && d.blocks(item.comment));
  const link = (label: string, onClick: () => void) => <Button variant="ghost" size="sm" aria-label={label} className={cn("size-8 shrink-0 px-0 text-muted-foreground", TOUCH_CONTROL)} onClick={onClick}><Icon name="ChevronRight" aria-hidden /></Button>;
  const fix = (label: string, onClick: () => void) => <Button variant="outline" size="sm" className={cn("h-7 shrink-0 px-2 text-xs", TOUCH_CONTROL)} onClick={onClick}>{label}</Button>;
  return (
    <Part title="Goes to GitHub">
      <ul className="space-y-1.5">
        <Row icon={<Icon name="CircleDashed" className="size-4 shrink-0 text-primary" aria-hidden />} action={comments.length > 0 && link("Show the comments to send", () => onList("not-submitted"))}>
          <MetaLine className="text-sm text-foreground" items={[comments.length ? plural(comments.length, "comment") : "No line comments", ...(d.counts ? d.counts.split(" · ").map((count) => <span className="text-muted-foreground">{count}</span>) : []), ...(d.preExistingCount ? [<span className="text-muted-foreground">{d.preExistingCount} pre-existing</span>] : [])]} />
          {agent > 0 && <p className="text-xs text-muted-foreground">{agent} written by the agent</p>}
        </Row>
        {older.length > 0 && <Row tone="warning" icon={<Icon name="AlertTriangle" className="size-4 shrink-0" aria-hidden />} action={<>
          <MoveToSummary comments={older.flatMap((item) => item.kind === "draft" ? [item.comment] : [])} variant="outline" className={cn("h-7 shrink-0 px-2 text-xs", TOUCH_CONTROL)} />
          {link("Show the comments on an older diff", () => onList("needs-you", older[0].id))}
        </>}>
          {plural(older.length, "comment")} on an older diff: edit or remove {older.length === 1 ? "it" : "them"}{movable && `, or move ${older.length === 1 ? "it" : "them"} to the summary`}
        </Row>}
        {replyDrafts > 0 && <Row icon={<Icon name="CornerDownRight" className="size-4 shrink-0 text-primary" aria-hidden />} action={link("Show the reply drafts", () => onList("all", items.find((item) => item.kind === "thread" && item.replyDraft)?.id ?? null))}>
          {plural(replyDrafts, "reply draft")} not sent: replies post on their own
        </Row>}
        {d.writing && <Row tone="warning" icon={<Icon name="Edit" className="size-4 shrink-0" aria-hidden />} action={!d.onSummary && fix("Show", () => d.inline ? reveal({ file: d.file, line: Number(d.line), side: d.side }) : onList("all"))}>
          {d.onSummary ? "You’re writing the summary" : d.asking ? <>You’re writing to the agent about <span className="font-mono text-xs">{d.file}:{d.boxLines}</span></> : <>You’re writing a comment on <span className="font-mono text-xs">{d.file}:{d.boxLines}</span></>}
        </Row>}
        {d.needsSummary && <Row tone="warning" icon={<Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden />} action={d.editable && !d.writing && fix("Write it", () => d.openComposer(SUMMARY_AT, false))}>Request changes needs a summary: say what has to change.</Row>}
        {d.approvingBlocked && <Row tone="warning" icon={<Icon name="AlertTriangle" className="size-4 shrink-0" aria-hidden />} action={blocking && fix("Show", () => onList("not-submitted", blocking.id))}>
          Approving with {plural(d.blockingCount, "blocking comment")}.
        </Row>}
        {d.approval && d.approval.unviewed.length > 0 && <Row tone="warning" icon={<Icon name="EyeOff" className="size-4 shrink-0" aria-hidden />} action={fix("Show", () => showLocation(d.approval!.unviewed[0], null, "RIGHT"))}>
          {unviewedDoubt(d.approval.unviewed)}
        </Row>}
        {d.approval?.rushed.map((chapter) => <Row key={chapter.id} tone="warning" icon={<Icon name="Clock" className="size-4 shrink-0" aria-hidden />}>{rushedDoubt(chapter)}</Row>)}
        {d.unreadApproval && <Row tone="warning" icon={<Icon name="EyeOff" className="size-4 shrink-0" aria-hidden />} action={fix("Show", () => showLocation(d.unreadApproval!.unread[0], null, "RIGHT"))}>
          The agent suggests Approve but read {readOf(d.unreadApproval)}
        </Row>}
      </ul>
      {held > 0 && <p className="px-0.5 text-xs text-muted-foreground">{held} sent to fix won’t post to GitHub. Reopen {held === 1 ? "it" : "one"} to post it.</p>}
      {d.notOnGithub > 0 && <p className="px-0.5 text-xs text-muted-foreground">{d.notOnGithub === 1 ? "1 comment isn’t on GitHub yet. It goes" : `${d.notOnGithub} comments aren’t on GitHub yet. They go`} with Send, not Submit.</p>}
    </Part>
  );
}

/**
 * Submit, pinned: the verdict on it, where it posts and as whom, or why it waits; the one more ask when in doubt; and
 * what GitHub or the server held it back for, in words, with what to do: Submit anyway, Submit as Comment, Open it on GitHub.
 */
function SubmitFoot({ onSubmit }: { onSubmit: (confirmed?: boolean, choice?: "anyway" | "comment") => void }) {
  const { review } = useWorkspace();
  const d = useDraft();
  // Comments on an older diff don't hold it: Submit warns, and Submit anyway moves them into the summary.
  const blocked = d.busy || d.rebuilding || !d.hasReview || d.writing || d.needsSummary;
  // While it posts, Submit keeps the focus it was clicked with.
  const unavailable = { disabled: blocked && !d.busy, "aria-disabled": d.busy || undefined };
  const where = review.repo && review.number ? `${review.repo}#${review.number}` : null;
  const ready = d.hint === "Drafts stay in BB until you submit.";
  const warned = d.warned;
  // While it posts, the choice keeps the focus it was clicked with.
  const choosing = { "aria-disabled": d.busy || undefined };
  const dismiss = () => { d.setWarned(null); requestAnimationFrame(() => d.submitRef.current?.focus()); };
  return (
    <footer className="shrink-0 space-y-2 border-t border-border p-3">
      {warned ? <div role="alert" className="space-y-2 rounded-lg border border-warning/25 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning-text">
        <p><span className="font-medium">Not submitted.</span> {warned.text.replace(/\s*Your draft (has been kept|is still here)\.$/, "")} Your draft is kept.</p>
        <div className="flex flex-wrap gap-2">
          {warned.offers.includes("anyway") && <Button size="sm" className={cn(TOUCH_CONTROL, BUSY)} {...choosing} onClick={() => { if (!d.busy) onSubmit(true, "anyway"); }}>{d.draft.verdict === "APPROVE" ? "Approve anyway" : "Submit anyway"}</Button>}
          {warned.newCommits && <UrlLink href={warned.newCommits.url} className={cn(buttonVariants({ size: "sm", variant: "outline" }), "text-foreground", TOUCH_CONTROL)}>{warned.newCommits.count ? `See the ${plural(warned.newCommits.count, "commit")}` : "See the new commits"}</UrlLink>}
          {warned.offers.includes("comment") && <Button size="sm" className={cn(TOUCH_CONTROL, BUSY)} {...choosing} onClick={() => { if (!d.busy) onSubmit(true, "comment"); }}>Submit as Comment</Button>}
          {warned.offers.includes("github") && where && <UrlLink href={review.url ?? `https://github.com/${where.replace("#", "/pull/")}`} className={cn(buttonVariants({ size: "sm" }), TOUCH_CONTROL)}><Icon name="Github" className="size-4" aria-hidden />Open it on GitHub</UrlLink>}
          <Button ref={d.confirmCancelRef} size="sm" variant="ghost" className={cn("text-muted-foreground hover:text-foreground", TOUCH_CONTROL)} onClick={dismiss}>Cancel</Button>
        </div>
      </div>
      : d.confirming ? <div role="alert" className="space-y-2 rounded-lg border border-warning/25 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning-text">
        <p>{d.approvingBlocked ? `Approve with ${plural(d.blockingCount, "blocking comment")}?` : `Submit ${VERDICT_LABEL[d.draft.verdict]}${d.commentCount ? ` with ${plural(d.commentCount, "comment")}` : ""}?`} {d.doubts.join(" ")}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className={cn(TOUCH_CONTROL, BUSY)} {...unavailable} onClick={() => { if (!blocked) onSubmit(true); }}>Submit anyway</Button>
          <Button ref={d.confirmCancelRef} size="sm" variant="ghost" className={TOUCH_CONTROL} onClick={() => { d.setConfirming(false); requestAnimationFrame(() => d.submitRef.current?.focus()); }}>Cancel</Button>
        </div>
      </div>
      : <Button ref={d.submitRef} className={cn("w-full gap-2", TOUCH_CONTROL, BUSY)} {...unavailable} onClick={() => { if (!blocked) onSubmit(); }}>
          {d.busy ? <Icon name="Loading" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Icon name="Github" className="size-4" aria-hidden />}
          {d.busy ? d.submitting ? "Submitting…" : "Saving…" : `Submit to GitHub · ${VERDICT_LABEL[d.draft.verdict]}${d.approvingBlocked ? ` · ${d.blockingCount} blocking` : ""}`}
        </Button>}
      <p className="text-xs leading-relaxed text-muted-foreground">{ready && where ? <>Posts to {where}{d.account ? <> as @{d.account}</> : null}.</> : d.hint}</p>
    </footer>
  );
}

/** What the review agent did on GitHub when you asked, newest first, a line each: "Posted reply on src/a.ts:12 · 2m ago". */
function AgentActivity() {
  const { review } = useWorkspace();
  const navigate = useBbNavigate();
  const [all, setAll] = useState(false);
  const entries = review.activity ?? [];
  if (!entries.length) return null;
  // Folded only from 5 up, so Show all never hides a single line.
  const folds = entries.length >= 5;
  const shown = [...entries].reverse().slice(0, all || !folds ? undefined : 3);
  return (
    <Part title="Agent activity">
      <ul className="space-y-1.5">
        {shown.map((entry, index) => <li key={`${entry.at}-${index}`} className="flex items-start gap-1.5">
          <Icon name="Sparkles" className="mt-0.5 size-3 shrink-0 text-(--ansi-13)" aria-hidden />
          <MetaLine className="min-w-0" items={[
            <span className="whitespace-normal break-words text-foreground">{entry.text}</span>,
            timeAgo(entry.at),
            entry.asking === "relayed" ? entry.from
              ? <span className="whitespace-normal">asked from <button type="button" className={cn("relative italic text-primary hover:underline", TOUCH_TARGET)} onClick={() => navigate.toThread(entry.from!)}>{entry.fromTitle ?? "another thread"} ↗</button></span>
              : "asked from another thread" : null,
            entry.url ? <UrlLink href={entry.url} aria-label={`${entry.text}, on GitHub`} className={cn("relative text-primary hover:underline", TOUCH_TARGET)}>View</UrlLink> : null,
          ]} />
        </li>)}
      </ul>
      {folds && <Button variant="ghost" size="sm" aria-expanded={all} className={cn("-ml-2 h-7 px-2 text-xs text-muted-foreground", TOUCH_CONTROL)} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${entries.length}`}</Button>}
    </Part>
  );
}

/** A closed or merged PR's review: archived, with its unsubmitted draft to read. */
function Archived() {
  const { review } = useWorkspace();
  const d = useDraft();
  const merged = review.prState === "MERGED";
  return (
    <section aria-label="Archived review" className="space-y-2 rounded-lg border border-border bg-muted/25 p-3">
      <p className="flex items-center gap-2 text-sm font-medium"><Icon name={merged ? "GitMerge" : "GitPullRequestClosed"} className={cn("size-4", merged ? "text-pr-merged" : "text-destructive-text")} aria-hidden />{merged ? "Merged" : "Closed"} · Archived</p>
      <p className="text-xs leading-relaxed text-muted-foreground">This review is saved in Archive. The guide, notes, and conversation remain available.</p>
      {(d.draft.comments.length > 0 || d.draft.body) && <details className="text-sm"><summary className="cursor-pointer">Unsubmitted draft</summary><p className="mt-2 whitespace-pre-wrap">{d.draft.body}</p>{d.draft.comments.map((comment, index) => <p key={index} className="mt-2 break-words">{comment.file}:{comment.line} — {comment.body}</p>)}</details>}
    </section>
  );
}

/** Your last review, sent before: its verdict, when, and where it is on GitHub. */
function LastReview() {
  const { review } = useWorkspace();
  const d = useDraft();
  const url = d.receiptUrl ?? review.url;
  return (
    <section aria-label="Submitted review" className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-success/25 bg-success/10 px-3 py-1.5 text-xs">
      <Icon name="BadgeCheck" className="size-4 shrink-0 text-diff-added" aria-hidden />
      <span className="font-medium text-diff-added">{RECEIPT_LABEL[d.submittedVerdict!]}</span>
      {timeAgo(review.submittedAt) && <span className="text-muted-foreground">· your last review, {timeAgo(review.submittedAt)}</span>}
      {url && <UrlLink href={url} className={cn("relative ml-auto text-primary hover:underline", TOUCH_TARGET)}>View on GitHub</UrlLink>}
    </section>
  );
}

/** After Submit: what went where, and the next review that needs you. */
function Receipt({ sent }: { sent: { comments: number; at: number } | null }) {
  const localDiffChanges = useKnob("localDiffChanges");
  const api = useWorkspace();
  const { review, targetKey } = api;
  const d = useDraft();
  const rpc = useRpc<typeof rpcContract>();
  const [next, setNext] = useState<ReviewItem | null | undefined>();
  useEffect(() => {
    let cancelled = false;
    rpc.call("listReviews", null).then(({ reviews }) => {
      if (cancelled) return;
      const waiting = (reviews as ReviewItem[]).filter((other) => other.targetKey !== targetKey && reviewState(other).group === "needs").sort(needsOrder);
      setNext(waiting[0] ?? null);
    }, () => { if (!cancelled) setNext(null); });
    return () => { cancelled = true; };
  }, [rpc, targetKey]);
  const verdict = d.submittedVerdict!;
  const where = review.repo && review.number ? `${review.repo}#${review.number}` : null;
  const when = sent?.at ?? review.submittedAt ?? null;
  const url = d.receiptUrl ?? review.url;
  // It replaces the Submit that had the focus: take it, unless it went somewhere else meanwhile.
  const receipt = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body) receipt.current?.focus();
  }, []);
  return <>
    <section ref={receipt} tabIndex={-1} aria-label="Submitted review" className="space-y-3 rounded-lg border border-success/25 bg-success/10 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background">
      <p className="flex items-center gap-2 text-sm font-medium text-diff-added"><Icon name="BadgeCheck" className="size-5" aria-hidden />{RECEIPT_LABEL[verdict]}</p>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <p>{where ? <>Posted to {where}{d.account ? <> as @{d.account}</> : null}</> : "Review submitted to GitHub"}{age(when) && ` · ${age(when)}`}</p>
        {sent && <p>{plural(sent.comments, "comment")}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {url && <UrlLink href={url} className={cn(buttonVariants({ variant: "outline", size: "sm" }), TOUCH_CONTROL)}><Icon name="Github" className="size-4" aria-hidden />View on GitHub</UrlLink>}
        <Button variant="outline" size="sm" className={TOUCH_CONTROL} onClick={() => d.setWriteAnother(true)}>Add another review</Button>
      </div>
    </section>
    {next !== undefined && <section aria-label="Next review" className="space-y-2 border-t border-border pt-3">
      {next ? <>
        <h3 className="px-0.5 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Next in Needs review</h3>
        <div className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card py-1.5 pl-3 pr-1.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium"><InlineCode text={reviewIdentity(next).name} /></p>
            <p className="truncate text-xs text-muted-foreground">{[statusWhy(next, { localDiffChanges })?.text, next.number ? `#${next.number}` : null, age(reviewState(next).at ?? next.createdAt)].filter(Boolean).join(" · ")}</p>
          </div>
          <Button size="sm" className={cn("shrink-0", TOUCH_CONTROL)} onClick={() => void api.leave(next.targetKey)}>Open</Button>
        </div>
      </> : <p className="text-sm text-muted-foreground">Nothing else needs you right now.</p>}
      <Button variant="ghost" size="sm" className={cn("-ml-2 text-muted-foreground", TOUCH_CONTROL)} onClick={() => void api.leave()}><Icon name="ChevronLeft" className="size-4" aria-hidden />All reviews</Button>
    </section>}
  </>;
}

/** Whether Finish shows your private notes: only when you have some, or an unsaved copy waits in this browser. */
function usePrivateNotes(targetKey: string, shown: boolean): { show: boolean } {
  const rpc = useRpc<typeof rpcContract>();
  const [show, setShow] = useState(false);
  const checked = useRef(false);
  useEffect(() => {
    if (!shown || checked.current) return;
    checked.current = true;
    let backup = false;
    try { backup = !!JSON.parse(localStorage.getItem(`gr:notes-draft:${targetKey}`) ?? "null")?.body; } catch { /* best effort */ }
    if (backup) { setShow(true); return; }
    rpc.call("getReviewerNotes", { targetKey }).then(({ body }) => { if (body.trim()) setShow(true); }, () => {});
  }, [rpc, targetKey, shown]);
  return useMemo(() => ({ show }), [show]);
}

/** Your private notes from before notes were retired: read, edit, or clear them here. */
function PrivateNotes({ targetKey }: { targetKey: string }) {
  return (
    <details className="group/notes rounded-lg border border-border bg-muted/20">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <Icon name="Lock" className="size-3.5 text-subtle-foreground" aria-hidden />Private notes
        <Icon name="ChevronDown" className="ml-auto size-3.5 text-subtle-foreground transition-transform duration-150 group-open/notes:rotate-180" aria-hidden />
      </summary>
      <div className="border-t border-border"><ReviewerNotes targetKey={targetKey} /></div>
    </details>
  );
}
