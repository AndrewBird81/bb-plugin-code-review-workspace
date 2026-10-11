import { useEffect, useState, type KeyboardEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../src/rpc-contract";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { timeAgo } from "./time-ago";

type PrCommit = z.infer<typeof rpcContract.getPrCommits.output>["commits"][number];

const short = (sha: string) => sha.slice(0, 7);

/** What the diff is compared with: "Since your review", or "Since abc1234, 3 commits ago". */
export function compareLabel(from: string | null, commits: readonly PrCommit[] | null): string {
  if (!from) return "Since your review";
  // Newest first, from the diff shown: a commit's place is how many commits ago it was.
  const ago = commits?.findIndex((commit) => commit.sha === from) ?? -1;
  return ago > 0 ? `Since ${short(from)}, ${ago} commit${ago === 1 ? "" : "s"} ago` : `Since ${short(from)}`;
}

/** Moves focus between the commits in the list. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const items = Array.from(event.currentTarget.closest("[data-commits]")?.querySelectorAll<HTMLElement>("[data-commit]") ?? []);
  items[items.indexOf(event.target as HTMLElement) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
}

/**
 * The diff's Since control: it narrows the diff to what changed since your last review, or since a
 * commit of the PR you pick. A PR you haven't reviewed can still be compared from one of its commits.
 */
export function ComparePicker({ targetKey, baseline, head, from, onFrom, available, pickable, pressed, onToggle }: {
  targetKey: string;
  /** The commit you last reviewed, if you have. */
  baseline: string | null;
  /** The commit the diff shows. */
  head: string | null;
  /** The commit picked, or null for your last review. */
  from: string | null;
  onFrom: (sha: string | null) => void;
  /** The comparison is loaded, so the diff can narrow to it. */
  available: boolean;
  /** A PR's commits can be picked; a local review only has your review to compare with. */
  pickable: boolean;
  pressed: boolean;
  onToggle: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  // The commits up to the head they were read at: a new push adds some, and moves each one further back.
  const [listed, setListed] = useState<{ head: string | null; commits: PrCommit[] } | null>(null);
  const commits = listed?.head === head ? listed.commits : null;
  const [error, setError] = useState<string | null>(null);
  const label = compareLabel(from, commits);

  function load() {
    setError(null);
    rpc.call("getPrCommits", { targetKey }).then((result) => {
      if (result.error) setError(result.error);
      else setListed({ head, commits: result.commits });
    }, (reason) => setError(reason instanceof Error ? reason.message : "Couldn’t read the PR’s commits."));
  }
  // A comparison picked before the toolbar last drew, or before a new push, needs the commits for its label;
  // the menu open at a push needs them to list.
  useEffect(() => { if ((from || open) && !commits) load(); }, [from, head]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (sha: string | null) => { setOpen(false); onFrom(sha === baseline ? null : sha); };
  const choices = commits?.filter((commit) => commit.sha !== head) ?? [];
  const item = "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none";

  return (
    <span className="inline-flex items-center">
      {available && (
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={pressed}
          className={cn("h-9 gap-1.5 px-2 text-xs text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:bg-primary/15 md:h-7", pickable && "rounded-r-none")}
          onClick={onToggle}
        >
          <Icon name="GitCommit" className="size-3.5" aria-hidden />
          {label}
        </Button>
      )}
      {pickable && <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next && !commits) load(); }}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Compare from a commit" className={cn("h-9 gap-1 px-1.5 text-xs text-muted-foreground md:h-7", available && "rounded-l-none")}>
            {!available && <><Icon name="GitCommit" className="size-3.5" aria-hidden />Compare</>}
            <Icon name="ChevronDown" className="size-3.5" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" mobileTitle="Compare from a commit" className="w-80 max-w-[calc(100vw-24px)] p-1">
          <p className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">Show what changed since</p>
          <div data-commits role="list" aria-label="Commits" className="max-h-80 overflow-y-auto">
            {baseline && (
              <button type="button" data-commit role="listitem" aria-current={!from ? "true" : undefined} onKeyDown={moveFocus} className={item} onClick={() => pick(null)}>
                <Icon name={!from ? "Check" : "GitCommit"} className={cn("mt-px size-3.5 shrink-0", !from ? "text-primary" : "text-subtle-foreground")} aria-hidden />
                <span className="min-w-0 flex-1">Your last review <span className="font-mono text-subtle-foreground">{short(baseline)}</span></span>
              </button>
            )}
            {!commits && !error && <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">Loading commits…</p>}
            {error && <p role="alert" className="px-2 py-1.5 text-xs text-destructive-text">{error}</p>}
            {commits && !choices.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">The diff shown is the PR’s only commit.</p>}
            {choices.map((commit) => {
              const chosen = commit.sha === from;
              const reviewed = commit.sha === baseline;
              return (
                <button key={commit.sha} type="button" data-commit role="listitem" aria-current={chosen ? "true" : undefined} onKeyDown={moveFocus} className={item} onClick={() => pick(commit.sha)}>
                  <Icon name={chosen ? "Check" : "GitCommit"} className={cn("mt-px size-3.5 shrink-0", chosen ? "text-primary" : "text-subtle-foreground")} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">{commit.headline || short(commit.sha)}</span>
                    <span className="flex gap-1.5 text-[11px] text-subtle-foreground">
                      <span className="font-mono">{short(commit.sha)}</span>
                      {commit.committedAt && <span>{timeAgo(commit.committedAt)}</span>}
                      {reviewed && <span className="font-medium text-primary">Your review</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>}
    </span>
  );
}
