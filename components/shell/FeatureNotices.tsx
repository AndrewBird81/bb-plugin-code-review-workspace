import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import type { FeatureCheck } from "../../src/feature-review";
import type { FeatureReview } from "../../src/store";
import { flaggedFileNotice, hiddenFileNotice } from "../../lib/folder-files";
import { branchLabel } from "../../lib/review-identity";
import { useKnob } from "../../lib/settings";
import { cn } from "../../lib/utils";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import type { Notice } from "./ReviewNotices";

/** The review, as far as its folder's notices read it. */
interface Reviewed { kind?: "pr" | "ref"; feature?: FeatureReview | null; archivedAt?: number | null; userArchivedAt?: number | null }

const BUTTON = cn("h-7", TOUCH_CONTROL);
// A branch's name never breaks across lines.
const Code = ({ children }: { children: string }) => <span className="whitespace-nowrap font-mono">{children}</span>;
/** "a, b and 2 more": names as a notice lists them. */
const listed = (names: string[], shown = 2) => names.length > shown ? `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`
  : names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

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
 * it; it's on another branch, which pauses the review, with Open or Start that branch's review; its machine is offline;
 * it changed, with Update; committed files that look like secrets, with Got it; the review its PR had already; files it
 * keeps out, each secret named on its own button; and the other threads editing it. Asked on open, and again when the
 * review or its folder changes. `onChanged` reloads the review.
 */
export function useFeatureNotices(targetKey: string, review: Reviewed | null, onChanged: () => void): Notice[] {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const localDiffChanges = useKnob("localDiffChanges");
  const local = !!review?.feature && review.kind === "ref";
  const [read, setRead] = useState<{ targetKey: string; check: FeatureCheck } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ask = useCallback(() => {
    if (!local) return;
    // Without an answer there's nothing to say.
    rpc.call("checkFeature", { targetKey }).then((check) => setRead({ targetKey, check }), () => {});
  }, [rpc, targetKey, local]);
  useEffect(ask, [ask, localDiffChanges]);
  useRealtime(`review:${targetKey}`, ask);
  useRealtime(`folder:${targetKey}`, ask);
  const check = local && read?.targetKey === targetKey ? read.check : null;
  if (!check || !review?.feature) return [];
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
  const button = (id: string, label: string, onClick: () => void, { aria, warning }: { aria?: string; warning?: boolean } = {}) => (
    <Button variant="outline" size="sm" className={cn(BUTTON, "max-w-64", warning && "border-warning/40")} disabled={!!busy} aria-label={aria} onClick={onClick}><span className="truncate">{busy === id ? `${label}…` : label}</span></Button>
  );
  const checkAgain = button("check", "Check again", () => { setBusy("check"); rpc.call("checkFeature", { targetKey }).then((next) => setRead({ targetKey, check: next }), () => {}).finally(() => setBusy(null)); });

  // Each with one action, its icon and the action on the text's first line however it wraps.
  const notices: Notice[] = [];
  const add = (notice: Notice) => notices.push({ firstLine: true, ...notice });
  if (check.state === "gone") {
    const archived = !!review.archivedAt || !!review.userArchivedAt;
    add({ id: "folder-gone", tone: "warning", icon: "Folder", label: "Folder removed",
      text: `BB removed this folder. The review keeps its last changes${archived ? "" : " and your comments"}.`,
      ...archived ? {} : { action: button("archive", "Archive", () => void act("archive", () => rpc.call("archiveReview", { targetKey, archived: true }), "Couldn’t archive the review."), { warning: true }) } });
  }
  if (check.state === "paused" && check.branch !== undefined) {
    const other = check.branch ?? "HEAD";
    const short = branchLabel(other);
    const existing = check.branchReview;
    add({ id: "folder-paused", tone: "warning", icon: "GitBranch", label: "Review paused",
      text: <>Folder is on <Code>{short}</Code>. This review waits for <Code>{branchLabel(feature.branch)}</Code>.</>,
      // A detached HEAD has no branch to review.
      ...check.branch ? { action: existing
        ? button("branch", `Open ${short} review`, () => navigate.toPluginPanel("review", { subPath: existing }), { warning: true })
        : button("branch", `Start a review of ${short}`, () => void act("branch", async () => {
          const started = await rpc.call("reviewFolderBranch", { targetKey });
          if (started.ok && started.targetKey) navigate.toPluginPanel("review", { subPath: started.targetKey });
          return started;
        }, "Couldn’t start that branch’s review."), { warning: true }) } : {} });
  }
  if (check.state === "offline" || check.state === "unavailable") {
    // A machine that's asleep is routine; a folder that can't be read isn't.
    add(check.state === "offline"
      ? { id: "folder-unread", tone: "info", icon: "WifiOff", label: "Machine offline", text: `${feature.machine} is offline. This is the folder as last read.`, action: checkAgain }
      : { id: "folder-unread", tone: "warning", icon: "AlertTriangle", text: check.message ?? "Couldn’t read the folder.", action: checkAgain });
  }
  if (check.state === "changed" && localDiffChanges) {
    add({ id: "folder-changed", tone: "info", icon: "FileDiff", label: "Folder changed",
      text: `${files(check.changedFiles ?? 1)} changed since your last update.`,
      action: button("update", "Update", () => void act("update", () => rpc.call("updateFeature", { targetKey }), "Couldn’t update the review.")) });
  }
  if (check.flagged.length) {
    add({ id: "folder-flagged", tone: "warning", icon: "AlertTriangle",
      text: check.flagged.length === 1 ? flaggedFileNotice(check.flagged[0]!) : `${listed(check.flagged, 3)} look like secrets and are committed. Check they belong in the repo.`,
      action: button("flagged", "Got it", () => void act("flagged", () => rpc.call("dismissFlagged", { targetKey, files: check.flagged }), "Couldn’t save that."), { warning: true }) });
  }
  if (check.prReview) {
    add({ id: "pr-review", tone: "info", icon: "GitPullRequest", text: "This branch’s PR has a review of its own.", action: button("pr", "Open PR review", () => navigate.toPluginPanel("review", { subPath: check.prReview! })) });
  }
  // A secret goes to agents only from a button that names it.
  for (const file of check.hidden.filter((hidden) => hidden.reason === "secret")) {
    add({ id: `folder-secret:${file.path}`, tone: "info", icon: "EyeOff", label: "File not shown",
      text: `${file.path} looks like a secret, so it isn’t shown or sent to agents.`,
      action: button(`secret:${file.path}`, `Send ${file.path} to agents`, () => void act(`secret:${file.path}`, () => rpc.call("includeHidden", { targetKey, files: [file.path], included: true }), "Couldn’t include it.")) });
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
      action: button("open", "Open", () => open(first!.threadId), { aria: `Open ${first!.title}` }) });
  }
  return notices;
}
