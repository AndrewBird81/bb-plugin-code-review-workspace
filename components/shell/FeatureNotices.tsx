import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import type { FeatureCheck } from "../../src/feature-review";
import type { FeatureReview, MainThread } from "../../src/store";
import { flaggedFileNotice, hiddenFileNotice } from "../../lib/folder-files";
import { branchLabel, homeShort, localIdOf } from "../../lib/review-identity";
import { useKnob } from "../../lib/settings";
import { cn } from "../../lib/utils";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { Icon } from "../ui/icon";
import { useFullscreenPortalContainer } from "../../lib/portal-scope";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { REWRITE_GUIDE, type Notice } from "./ReviewNotices";
import { usePrNotices, type PrReviewed } from "./PrNotices";
import { useComments } from "../comments/store";

/** The review, as far as its folder's notices read it. */
interface Reviewed { kind?: "pr" | "ref"; status?: string; feature?: FeatureReview | null; mainThread?: Pick<MainThread, "environmentId"> | null; archivedAt?: number | null; userArchivedAt?: number | null; followed?: { branch: string; from: string } | null }

const BUTTON = cn("h-7", TOUCH_CONTROL);
// A branch's name never breaks across lines.
const Code = ({ children }: { children: string }) => <span className="whitespace-nowrap font-mono">{children}</span>;
/** A branch or path that wraps only after a slash or hyphen, never mid-word, on a phone. */
const Wrappable = ({ text }: { text: string }) => <>{text.split(/(?<=\w[/-])/).map((part, i) => <span key={i}>{i > 0 && <wbr />}{part}</span>)}</>;
/** "a, b and 2 more": names as a notice lists them. */
const listed = (names: string[], shown = 2) => names.length > shown ? `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`
  : names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
/** Why the guide is older than the diff (FeatureReview's guideOlderThanDiff), as its notice says it. */
const GUIDE_OLDER: Record<NonNullable<FeatureReview["guideOlderThanDiff"]>, string> = {
  update: "The guide was written before your last Update.",
  include: "The guide was written before you changed which files are shown.",
  push: "The guide was written before the PR’s latest commits.",
  pr: "The guide was written for the local changes, before the PR.",
};
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** "and 2 more", which opens a list of those threads, each going to its thread. */
function MoreThreads({ threads, onOpen }: { threads: FeatureCheck["alsoActive"]; onOpen: (threadId: string) => void }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" className="rounded-sm font-medium underline decoration-border underline-offset-4 hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{threads.length} more</button>
    </PopoverTrigger>
    <PopoverContent align="start" mobileTitle="Also editing this folder" className="w-72 max-w-[calc(100vw-2rem)] p-1">
      <ul aria-label="Also editing this folder">
        {threads.map((thread) => <li key={thread.threadId}>
          <Button variant="ghost" size="sm" className={cn("w-full justify-start", TOUCH_CONTROL)} onClick={() => { setOpen(false); onOpen(thread.threadId); }}><span className="truncate">{thread.title}</span></Button>
        </li>)}
      </ul>
    </PopoverContent>
  </Popover>;
}

/**
 * A local review's notices about its folder (src/feature-review.ts checkFeature), the most pressing first: BB removed
 * it; it's on another branch, which pauses the review, with New review for it or Follow it instead, or a link to its
 * review; the review followed its renamed branch, and the id it had, with Got it; its machine is offline;
 * it changed, with Update; its guide is older than what Update last showed, with Rewrite guide; committed files that look like secrets, with Got it; its PR's (PrNotices.tsx),
 * which a PR's review has too; files it keeps out, each secret named on its own button; and the other threads editing
 * it. A PR's review whose folder is still there says what in it isn't on GitHub yet, with Review them (`onNotPushed`), but
 * on Not pushed yet's page, where `onNotPushed` is null. `onNeedsYou` opens Comments at Needs you.
 * Asked on open, and again when the review or its folder changes. `onChanged` reloads the review.
 */
export function useFeatureNotices(targetKey: string, review: (Reviewed & PrReviewed) | null, onChanged: () => void, onNotPushed: (() => void) | null, onNeedsYou: () => void): Notice[] {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const localDiffChanges = useKnob("localDiffChanges");
  const container = useFullscreenPortalContainer();
  const prNotices = usePrNotices(targetKey, review, onChanged, onNeedsYou);
  // Your open comments on lines only in the folder, as Comments lists them.
  const localComments = useComments(targetKey, "items").filter((item) => item.kind === "draft" && item.comment.side === "LOCAL" && (!item.comment.state || item.comment.state === "open")).length;
  const local = !!review?.feature && review.kind === "ref";
  const attached = local || !!review?.feature && review.kind === "pr" && !review.feature.folderGone;
  const [read, setRead] = useState<{ targetKey: string; check: FeatureCheck } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ask = useCallback(() => {
    if (!attached) return;
    // Without an answer there's nothing to say.
    rpc.call("checkFeature", { targetKey }).then((check) => setRead({ targetKey, check }), () => {});
  }, [rpc, targetKey, attached]);
  useEffect(ask, [ask, localDiffChanges]);
  useRealtime(`review:${targetKey}`, ask);
  useRealtime(`folder:${targetKey}`, ask);
  // While the page shows, its branch's PR is looked for every 30 seconds (src/pr-watch.ts): one opened on GitHub makes
  // it the PR's review within the minute, which the review's signal reloads.
  useEffect(() => {
    if (!local) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") rpc.call("checkPr", { targetKey }).catch(() => {}); }, 30_000);
    return () => clearInterval(timer);
  }, [rpc, targetKey, local]);
  const check = attached && read?.targetKey === targetKey ? read.check : null;
  if (!check || !review?.feature) return prNotices;
  const { feature } = review;

  /** Run one notice's action; what went wrong shows as a toast, and the review reloads after one that worked. */
  const act = async (id: string, run: () => Promise<{ ok: boolean; error?: string }>, failed: string) => {
    if (busy) return;
    setBusy(id);
    try {
      const result = await run();
      if (!result.ok) toast.error(result.error ?? failed);
      else onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : failed);
    } finally {
      setBusy(null);
    }
  };
  // On a warning's tint, the button's border takes the tint's colour, so it shows in the dark.
  // `whole`: a label that must never be cut, as a file's name is; `hint`, the hover text; `description`, what it does
  // beyond its label, which is its hint too and its description for screen readers.
  // `agent`: it starts an agent, so it wears the agent's sparkle. `variant`: filled for the one recommended, ghost for a
  // quiet other choice.
  const button = (id: string, label: string, onClick: () => void, { aria, warning, whole, hint, description, agent, variant = "outline" }: { aria?: string; warning?: boolean; whole?: boolean; hint?: string; description?: string; agent?: boolean; variant?: "default" | "outline" | "ghost" } = {}) => {
    const shown = <Button variant={variant} size="sm" className={cn(BUTTON, !whole && "max-w-64", warning && "border-warning/40")} disabled={!!busy} aria-label={aria} aria-description={description} onClick={onClick}>{agent && <Icon name="Sparkles" className="text-(--ansi-13)" aria-hidden />}<span title={hint} className={cn(!whole && "truncate")}>{busy === id ? `${label}…` : label}</span></Button>;
    return description ? <Hint label={description} container={container}>{shown}</Hint> : shown;
  };
  const checkAgain = button("check", "Check again", () => { setBusy("check"); rpc.call("checkFeature", { targetKey }).then((next) => setRead({ targetKey, check: next }), () => {}).finally(() => setBusy(null)); });

  // Each with one action, its icon and the action on the text's first line however it wraps.
  const notices: Notice[] = [];
  const add = (notice: Notice) => notices.push({ firstLine: true, ...notice });
  if (check.state === "gone" && local) {
    const archived = !!review.archivedAt || !!review.userArchivedAt;
    // Its main thread worked there: the next Send starts a fresh thread from the branch (src/loop.ts).
    const fresh = !archived && (!review.mainThread || review.mainThread.environmentId === feature.environmentId);
    add({ id: "folder-gone", tone: "warning", icon: "Folder", label: "Folder removed",
      text: `BB removed this folder. The review keeps its last changes${archived ? "" : " and your comments"}.${fresh ? ` Your next Send starts a fresh thread from ${branchLabel(feature.workBranch ?? feature.branch)}.` : ""}`,
      ...archived ? {} : { action: button("archive", "Archive", () => void act("archive", () => rpc.call("archiveReview", { targetKey, archived: true }), "Couldn’t archive the review."), { warning: true }) } });
  }
  if (check.state === "paused" && check.branch !== undefined) {
    const other = check.branch ?? "HEAD";
    const short = branchLabel(other);
    const existing = check.branchReview;
    // A branch made from this one, as a stacked branch is, since a renamed one is followed: a review of its own is
    // the recommended choice.
    const start = button("branch", "New review for it", () => void act("branch", async () => {
      const started = await rpc.call("reviewFolderBranch", { targetKey });
      if (started.ok && started.targetKey) navigate.toPluginPanel("review", { subPath: started.targetKey });
      return started;
    }, "Couldn’t start that branch’s review."), { variant: "default" });
    const stays = <Code>{branchLabel(feature.branch)}</Code>;
    add({ id: "folder-paused", tone: "info", icon: "GitBranch", label: "Review paused",
      text: check.branch && !existing ? <>Folder moved to <Code>{short}</Code>, a new branch. This review stays with {stays}.</>
        : <>Folder is on <Code>{short}</Code>. This review waits for {stays}.</>,
      // A detached HEAD has no branch to review. A fresh thread's worktree's branch isn't the review's to follow.
      ...check.branch ? { action: existing
        ? button("branch", `${short} review ↗`, () => navigate.toPluginPanel("review", { subPath: existing }), { aria: `${short} review`, hint: `Go to the ${short} review` })
        : feature.workBranch || !local ? start
        : <span className="flex flex-wrap gap-1">
          {start}
          {button("follow", "Follow it instead", () => void act("follow", () => rpc.call("followFolderBranch", { targetKey }), "Couldn’t follow that branch."), { variant: "ghost" })}
        </span> } : {} });
  }
  if (review.followed && check.state !== "paused") {
    add({ id: "folder-followed", tone: "info", icon: "GitBranch", label: "Branch renamed",
      text: <>Now following <Code>{branchLabel(review.followed.branch)}</Code>. It was <Code>{localIdOf({ targetKey, feature: { ...feature, branch: review.followed.from } })}</Code>, which still opens it.</>,
      action: button("followed", "Got it", () => void act("followed", () => rpc.call("dismissFollowed", { targetKey }), "Couldn’t save that.")) });
  }
  if (check.state === "offline" || check.state === "unavailable") {
    // A machine that's asleep is routine; a folder that can't be read isn't.
    add(check.state === "offline"
      ? { id: "folder-unread", tone: "info", icon: "WifiOff", label: "Machine offline", text: `${feature.machine} is offline. This is the folder as last read.`, action: checkAgain }
      : { id: "folder-unread", tone: "warning", icon: "AlertTriangle", text: check.message ?? "Couldn’t read the folder.", action: checkAgain });
  }
  if (check.state === "ahead") {
    const n = check.aheadFiles ?? 1;
    add({ id: "folder-ahead", tone: "info", icon: "FileDiff", label: "Not pushed yet",
      text: `${files(n)} in the folder ${n === 1 ? "isn’t" : "aren’t"} on GitHub yet${localComments ? `, with ${localComments} of your comments` : ""}.`,
      ...onNotPushed ? { action: button("not-pushed", "Review them", onNotPushed) } : {} });
  }
  if (check.state === "changed" && localDiffChanges) {
    add({ id: "folder-changed", tone: "info", icon: "FileDiff", label: "Folder changed",
      text: `${files(check.changedFiles ?? 1)} changed since your last update.`,
      action: button("update", "Update", () => void act("update", () => rpc.call("updateFeature", { targetKey }), "Couldn’t update the review.")) });
  }
  // While a guide is being written, its own notice says so.
  // Not while a guide is being written, which has its own notice, nor once Rewrite guide can't run: the folder's gone,
  // or the review's archived.
  if (feature.guideOlderThanDiff && review.status !== "generating" && check.state !== "gone" && !review.archivedAt && !review.userArchivedAt) {
    add({ id: "guide-behind", tone: "info", icon: "Route", label: "Guide out of date",
      text: GUIDE_OLDER[feature.guideOlderThanDiff],
      action: button("rewrite", "Rewrite guide", () => void act("rewrite", () => rpc.call("rewriteGuide", { targetKey }), "Couldn’t rewrite the guide."), { description: REWRITE_GUIDE, agent: true }) });
  }
  if (check.flagged.length) {
    add({ id: "folder-flagged", tone: "warning", icon: "AlertTriangle",
      text: check.flagged.length === 1 ? flaggedFileNotice(check.flagged[0]!) : `${listed(check.flagged, 3)} look like secrets and are committed. Check they belong in the repo.`,
      action: button("flagged", "Got it", () => void act("flagged", () => rpc.call("dismissFlagged", { targetKey, files: check.flagged }), "Couldn’t save that."), { warning: true }) });
  }
  notices.push(...prNotices);
  // A secret goes to agents only from a button that names it: its name, whole, on the button; its path in the text, the
  // hover and the button's accessible name.
  for (const file of check.hidden.filter((hidden) => hidden.reason === "secret")) {
    const label = `Send ${fileName(file.path)} to agents`;
    add({ id: `folder-secret:${file.path}`, tone: "info", icon: "EyeOff", label: "File not shown",
      text: `${file.path} looks like a secret, so it isn’t shown or sent to agents.`,
      action: button(`secret:${file.path}`, label, () => void act(`secret:${file.path}`, () => rpc.call("includeHidden", { targetKey, files: [file.path], included: true }), "Couldn’t include it."),
        { whole: true, hint: file.path, ...file.path !== fileName(file.path) ? { aria: `${label} (${file.path})` } : {} }) });
  }
  // Binaries can be included, as a line saying they differ; a diff too large to show can't.
  const rest = check.hidden.filter((hidden) => hidden.reason !== "secret");
  const binaries = rest.filter((hidden) => hidden.reason === "binary");
  if (rest.length) {
    add({ id: "folder-hidden", tone: "info", icon: "EyeOff", label: "Files not shown",
      text: rest.length === 1 ? hiddenFileNotice(rest[0]!) : `${files(rest.length)} aren’t shown: ${listed(rest.map((file) => file.path), 3)}.`,
      ...binaries.length ? { action: button("include", "Include", () => void act("include", () => rpc.call("includeHidden", { targetKey, files: binaries.map((file) => file.path), included: true }), "Couldn’t include them."),
        { aria: `Include ${listed(binaries.map((file) => file.path), 3)}` }) } : {} });
  }
  if (check.alsoActive.length) {
    const [first, ...more] = check.alsoActive;
    const open = (threadId: string) => navigate.toThread(threadId);
    add({ id: "also-active", tone: "info", icon: "UserRound", label: "Also editing this folder",
      text: more.length
        ? <><em className="font-medium">{first!.title}</em> and <MoreThreads threads={more} onOpen={open} /> are also editing this folder; their changes are in this review.</>
        : <><em className="font-medium">{first!.title}</em> is also editing this folder; its changes are in this review.</>,
      // The button names the thread it goes to.
      action: button("open", `${first!.title} ↗`, () => open(first!.threadId), { aria: first!.title, hint: `Go to ${first!.title}` }) });
  }
  return notices;
}

/**
 * Branch kept: a branch a fixer made in a new worktree stays in the repo once BB removes the worktree, and the plugin
 * runs no git in your checkout, so each says so, with its delete command to copy (select it, if copying fails) and Got
 * it, which stops showing it. `onChanged` reloads the review.
 */
export function useBranchKeptNotices(targetKey: string, review: { keptBranches?: Array<{ branch: string; machine: string | null; path?: string | null }> } | null, onChanged: () => void): Notice[] {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState<string | null>(null);
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success("Copied"); }
    catch { toast.error("Couldn’t copy. Select the command instead."); }
  };
  const dismiss = async (branch: string) => {
    if (busy) return;
    setBusy(branch);
    try {
      const result = await rpc.call("dismissKeptBranch", { targetKey, branch });
      if (!result.ok) toast.error(result.error ?? "Couldn’t save that.");
      else onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t save that.");
    } finally { setBusy(null); }
  };
  return (review?.keptBranches ?? []).map(({ branch, machine, path }) => {
    const command = `git branch -D ${branch}`;
    const repo = path ? homeShort(path) : machine ? `the repo on ${machine}` : "the repo";
    return {
      id: `branch-kept:${branch}`, tone: "info", icon: "GitBranch", label: "Branch kept", firstLine: true,
      // -D deletes commits that never reached GitHub: the warning is part of the command's sentence.
      text: <>Branch kept: <span className="font-mono"><Wrappable text={branch} /></span>{machine ? ` on ${machine}` : ""}. The fixer’s folder is gone, but its branch is still in {path ? <span className="font-mono"><Wrappable text={repo} /></span> : repo}. To delete it, run <code className="select-all font-mono">{command.split(" ").map((word, i) => <span key={i}>{i ? " " : ""}<Wrappable text={word} /></span>)}</code>. This also deletes any commits on it that aren’t on GitHub.</>,
      action: <span className="flex gap-1">
        <Button variant="outline" size="sm" className={BUTTON} aria-label={`Copy ${command}`} onClick={() => void copy(command)}>Copy command</Button>
        <Button variant="ghost" size="sm" className={BUTTON} disabled={busy === branch} aria-label={`Got it: ${branch}`} onClick={() => void dismiss(branch)}>Got it</Button>
      </span>,
    } satisfies Notice;
  });
}
