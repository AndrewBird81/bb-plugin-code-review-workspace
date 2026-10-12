import { useId, useState, type ReactNode, type Ref } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../src/rpc-contract";
import { parsePrLink } from "../../lib/pr-link";
import type { ReviewItem } from "../../lib/review-state";
import { statusWhy } from "../../lib/status-line";
import { cn } from "../../lib/utils";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";

/**
 * Find a review, or paste a PR link: words filter the list as you type (`onQuery`); a link to a PR, or owner/repo#n,
 * offers to open it when it's listed and to review it when it isn't, which Enter takes. Focused and empty, it says
 * how to review a local branch.
 */
export function Omnibox({ query, onQuery, reviews, onOpen, placeholder, onCancel, inputRef, trailing, className }: {
  query: string;
  onQuery(query: string): void;
  /** Every review, to tell a PR that's listed from one that isn't. */
  reviews: ReviewItem[];
  onOpen(targetKey: string): void;
  placeholder: string;
  /** Where it opens on demand, as on a phone: Cancel closes it. */
  onCancel?: () => void;
  inputRef?: Ref<HTMLInputElement>;
  /** At the end of its row, such as the page's own Refresh and Settings. */
  trailing?: ReactNode;
  className?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const suggestionId = useId(), errorId = useId(), hintId = useId();
  const link = parsePrLink(query);
  const listed = link ? reviews.find((review) => review.repo?.toLowerCase() === link.repo && review.number === link.number) : undefined;
  const listedWhy = listed ? statusWhy(listed) : null;

  async function take() {
    if (!link || starting) return;
    if (listed) {
      onQuery("");
      onOpen(listed.targetKey);
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const result = await rpc.call("startReview", { input: link.url });
      if (result.ok && result.targetKey) {
        onQuery("");
        onOpen(result.targetKey);
      } else setError(result.error ?? "Couldn’t start the review. Try again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t start the review. Try again.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <form role="search" className={cn("relative", className)} onSubmit={(event) => { event.preventDefault(); void take(); }}>
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Icon name="Search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={inputRef}
            type="search"
            value={query}
            aria-label="Find a review, or paste a PR link"
            aria-invalid={!!error}
            aria-describedby={error ? errorId : link ? suggestionId : focused && !query ? hintId : undefined}
            placeholder={placeholder}
            onChange={(event) => { onQuery(event.target.value); setError(null); }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              if (query) onQuery("");
              else onCancel?.();
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="h-10 rounded-lg border-border bg-surface-raised pl-9 pr-9 shadow-xs hover:border-input focus-visible:border-primary/60 focus-visible:ring-[3px] focus-visible:ring-primary/20 aria-invalid:border-destructive/60 pointer-coarse:h-11 max-md:pointer-coarse:h-11"
          />
          {!query && !focused && <kbd aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-border px-1.5 font-sans text-[11px] leading-4 text-subtle-foreground pointer-fine:block">/</kbd>}
        </div>
        {onCancel && <Button type="button" variant="ghost" size="sm" className={cn("h-10 shrink-0 px-2.5 text-muted-foreground", TOUCH_CONTROL)} onClick={onCancel}>Cancel</Button>}
        {trailing}
      </div>
      {/* A pasted PR's suggestion takes the list's place; the hint shows over the list, so focusing the box moves no row. */}
      {link ? <div className="mt-1.5 rounded-lg border border-border bg-popover p-1 shadow-xs">
        <Button id={suggestionId} type="submit" variant="ghost" size="sm" disabled={starting} className={cn("h-9 w-full justify-start gap-2 px-2.5 text-sm text-foreground", TOUCH_CONTROL)}>
          <Icon name={starting ? "Loading" : listed ? "ArrowRight" : "Sparkles"} className={cn(starting && "animate-spin motion-reduce:animate-none", !listed && !starting && "text-(--ansi-13)")} aria-hidden />
          <span className="shrink-0">{starting ? "Starting…" : `${listed ? "Open" : "Review"} ${link.name}`}</span>
          <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">{listed ? listedWhy?.text ?? "" : "builds a guide"}</span>
          <kbd aria-hidden className="ml-auto hidden font-sans text-xs text-subtle-foreground pointer-fine:inline">↵</kbd>
        </Button>
      </div>
        : focused && !query && <p id={hintId} className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-md">
          For a local branch, run <code className="font-mono text-[11px] text-foreground">bb review</code> in a BB thread.
        </p>}
      {error && <p id={errorId} role="alert" className="mt-2 flex items-start gap-1.5 break-words text-sm text-destructive-text"><Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" aria-hidden />{error}</p>}
    </form>
  );
}
