import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../src/rpc-contract";
import { useFullscreenPortalContainer } from "../lib/portal-scope";
import { baselineOf } from "../lib/turn";
import { cn } from "../lib/utils";
import { useWorkspace, type WorkspaceApi } from "../lib/workspace-context";
import { TOUCH_COMPACT, TOUCH_CONTROL } from "./touch";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { Icon } from "./ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { timeAgo } from "./time-ago";

type PrCommit = z.infer<typeof rpcContract.getPrCommits.output>["commits"][number];

const short = (sha: string) => sha.slice(0, 7);

/** What the diff shows, as the compare select's label says it: "All changes", "Since your review", or "Since abc1234". */
export function compareLabel(narrowed: boolean, from: string | null, brief = false): string {
  if (!narrowed) return "All changes";
  return from ? `Since ${short(from)}` : brief ? "Since review" : "Since your review";
}

/** "3 commits ago": how far before the diff shown a picked commit is, in the PR's commits, newest first. */
function commitsAgo(from: string | null, commits: readonly PrCommit[] | null): string | null {
  const ago = from && commits ? commits.findIndex((commit) => commit.sha === from) : -1;
  return ago > 0 ? `${ago} commit${ago === 1 ? "" : "s"} ago` : null;
}

/** Why the diff can't narrow: "Couldn’t compare with your last review", and the reason, when there's more to say. */
export function compareProblem(compare: WorkspaceApi["compare"]): string | null {
  if (!compare.error) return null;
  const problem = `Couldn’t compare with ${compare.from ? short(compare.from) : "your last review"}`;
  return compare.error.startsWith("Couldn’t compare") ? problem : `${problem}: ${compare.error}`;
}

/** Your last review's commit, when the diff shown is a later one: something to compare with. */
export function lastReviewed(compare: WorkspaceApi["compare"]): string | null {
  return compare.baseline && compare.baseline !== compare.head ? compare.baseline : null;
}

/**
 * Shows the whole PR. A commit picked on a PR you haven't reviewed is let go, so its badges go with it; after your
 * review, they stay what they were.
 */
export function showAllChanges(compare: WorkspaceApi["compare"]) {
  if (compare.from && !lastReviewed(compare)) compare.pick(null);
  else compare.setNarrowed(false);
}

/** The PR's commits, read while `wanted`, and again once a push moves the diff's head. */
export function useCommits(wanted: boolean): { commits: PrCommit[] | null; error: string | null } {
  const { targetKey, compare } = useWorkspace();
  const rpc = useRpc<typeof rpcContract>();
  // The commits up to the head they were read at: a new push adds some, and moves each one further back.
  const [listed, setListed] = useState<{ head: string | null; commits: PrCommit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commits = listed?.head === compare.head ? listed.commits : null;
  useEffect(() => {
    if (!wanted || commits) return;
    const head = compare.head;
    setError(null);
    rpc.call("getPrCommits", { targetKey }).then((result) => {
      if (result.error) setError(result.error);
      else setListed({ head, commits: result.commits });
    }, (reason) => setError(reason instanceof Error ? reason.message : "Couldn’t read the PR’s commits."));
  }, [wanted, compare.head]); // eslint-disable-line react-hooks/exhaustive-deps
  return { commits, error };
}

/** Moves focus between the menu's choices. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const items = Array.from(event.currentTarget.closest("[role=menu]")?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? []);
  items[items.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
}

function Choice({ checked, label, detail, onSelect }: { checked: boolean; label: ReactNode; detail?: ReactNode; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onKeyDown={moveFocus}
      onClick={onSelect}
      className={cn("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none", TOUCH_CONTROL, "pointer-coarse:items-center")}
    >
      <Icon name="Check" className={cn("mt-0.5 size-3.5 shrink-0 text-primary pointer-coarse:mt-0", !checked && "invisible")} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {detail && <span className="block truncate font-mono text-[11px] text-subtle-foreground">{detail}</span>}
      </span>
    </button>
  );
}

/**
 * What the diff can show: all of the PR, what changed since your review, or since one of its commits, newest first.
 * Your reviewed commit is listed once, as your review. `onPicked` runs after a choice.
 */
export function CompareMenu({ commits, error, onPicked }: { commits: PrCommit[] | null; error: string | null; onPicked: () => void }) {
  const { review, compare } = useWorkspace();
  const pickable = review.kind === "pr";
  const lastReview = lastReviewed(compare);
  const reviewedAt = timeAgo(baselineOf(review).at);
  const choices = commits?.filter((commit) => commit.sha !== compare.head && commit.sha !== lastReview) ?? [];
  const choose = (act: () => void) => () => { act(); onPicked(); };
  return (
    <div role="menu" aria-label="Show changes" className="flex flex-col">
      <p aria-hidden className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Show changes</p>
      <Choice checked={!compare.narrowed} label="All changes in this PR" onSelect={choose(() => showAllChanges(compare))} />
      {lastReview && <Choice checked={compare.narrowed && !compare.from} label="Since your review" detail={[short(lastReview), reviewedAt].filter(Boolean).join(" · ")} onSelect={choose(() => compare.pick(null))} />}
      {pickable && (
        <div role="group" aria-label="Since a commit" className="mt-1 border-t border-border pt-1">
          <p aria-hidden className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Since a commit</p>
          {!commits && !error && <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">Loading commits…</p>}
          {error && <p role="alert" className="px-2 py-1.5 text-xs text-destructive-text">{error}</p>}
          {commits && !choices.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">No earlier commits to compare with.</p>}
          <div className="max-h-72 overflow-y-auto">
            {choices.map((commit) => (
              <Choice key={commit.sha} checked={compare.narrowed && compare.from === commit.sha} label={commit.headline || short(commit.sha)}
                detail={[short(commit.sha), timeAgo(commit.committedAt)].filter(Boolean).join(" · ")} onSelect={choose(() => compare.pick(commit.sha))} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The band's compare select. Its label is what the diff shows, tinted while it narrows the diff, and its menu changes
 * it. `brief` shortens the label for a narrow band.
 */
export function ComparePicker({ brief = false }: { brief?: boolean }) {
  const { review, compare, layout } = useWorkspace();
  const container = useFullscreenPortalContainer();
  const [open, setOpen] = useState(false);
  // The commits name how far back a picked one is, and the menu lists them.
  const { commits, error } = useCommits(review.kind === "pr" && (open || !!compare.from));
  const label = compareLabel(compare.narrowed, compare.from, brief);
  const ago = compare.narrowed ? commitsAgo(compare.from, commits) : null;
  const problem = compareProblem(compare);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint label={problem ?? ago ?? "Show changes"} container={container}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Show changes: ${label}${ago ? `, ${ago}` : ""}${problem ? `. ${problem}` : ""}`}
            className={cn(
              "h-8 shrink-0 gap-1 px-2 text-xs font-medium text-muted-foreground aria-expanded:bg-state-active",
              compare.narrowed && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary aria-expanded:bg-primary/15",
              layout.mode === "short" ? TOUCH_COMPACT : TOUCH_CONTROL,
            )}
          >
            {problem && <Icon name="AlertCircle" className="size-3.5 text-destructive-text" aria-hidden />}
            <span aria-hidden>{label}</span>
            <Icon name="ChevronDown" className="size-3.5 opacity-70" aria-hidden />
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" mobileTitle="Show changes" className="w-80 max-w-[calc(100vw-24px)] p-1"
        onOpenAutoFocus={(event) => {
          // On the choice the diff shows, for the arrow keys to move from.
          event.preventDefault();
          (event.target as HTMLElement).querySelector<HTMLElement>("[aria-checked=true]")?.focus();
        }}>
        <CompareMenu commits={commits} error={error} onPicked={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
