import { memo, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { searchIndex, searchReview, type SearchHit } from "../lib/review-search";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import { InlineCode } from "./ui/inline-code";

interface Section { id: string; title: string; overview: string; diffs: { file: string; summary?: string }[] }

/** The match in its text, with some of the text before it when that's long. */
function Snippet({ text, at, length }: { text: string; at: number; length: number }) {
  const from = at > 40 ? at - 30 : 0;
  return (
    <>
      {from > 0 && "…"}{text.slice(from, at).trimStart()}
      <mark className="rounded-sm bg-primary/20 text-foreground">{text.slice(at, at + length)}</mark>
      {text.slice(at + length)}
    </>
  );
}

/** Moves focus between results, or back to the box from the first. */
function moveFocus(event: KeyboardEvent<HTMLElement>, box: HTMLInputElement | null) {
  if (event.key === "Escape") { event.preventDefault(); box?.focus(); return; }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const rows = Array.from(event.currentTarget.closest("[data-find]")?.querySelectorAll<HTMLElement>("[data-hit]") ?? []);
  const next = rows[rows.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)];
  if (next) next.focus();
  else if (event.key === "ArrowUp") box?.focus();
}

/**
 * Find in review: searches the whole change, not just the chapter shown — both sides of every line
 * of the diff, and the guide's chapters and file summaries. Its box heads the navigator, after
 * `leading`, and while there's a query its results take the place of `children`, which scroll below.
 */
export const FindInReview = memo(function FindInReview({ patch, sections, onOpenLine, onOpenChapter, onOpenFile, leading, initialQuery = "", onQuery, children }: {
  patch: string;
  sections: readonly Section[];
  onOpenLine: (file: string, line: number, side: "LEFT" | "RIGHT") => void;
  onOpenChapter: (chapterId: string) => void;
  onOpenFile: (chapterId: string, file: string) => void;
  leading?: ReactNode;
  /** The query a remounted workspace had typed (lib/remount.ts). */
  initialQuery?: string;
  onQuery?: (query: string) => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => onQuery?.(query), [query, onQuery]);
  const box = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // "clearfind" empties the box at once, so what the results hide can take focus.
  useEffect(() => {
    const clear = () => flushSync(() => setQuery(""));
    const el = root.current;
    el?.addEventListener("clearfind", clear);
    return () => el?.removeEventListener("clearfind", clear);
  }, []);
  const searched = useDeferredValue(query.trim());
  const active = searched !== "";
  // Built when a search starts, and again only when the diff or guide changes.
  const index = useMemo(() => active ? searchIndex(patch, sections) : null, [active, patch, sections]);
  const { hits, total } = useMemo(() => index ? searchReview(index, searched) : { hits: [], total: 0 }, [index, searched]);
  const titles = useMemo(() => new Map(sections.map((section) => [section.id, section.title])), [sections]);

  const open = (hit: SearchHit) => {
    if (hit.kind === "line") onOpenLine(hit.file, hit.line, hit.side);
    else if (hit.kind === "summary" && hit.file) onOpenFile(hit.chapterId, hit.file);
    else onOpenChapter(hit.chapterId);
  };

  return (
    <div ref={root} data-find className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-1.5">
      {leading}
      <div role="search" className="relative min-w-0 flex-1">
      {/* A label, so a tap just above or below the box, within its 44px target on a coarse pointer, still lands in it. */}
      <label className="block pointer-coarse:py-1">
        <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground" aria-hidden />
        <Input
          ref={box}
          data-find-box
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && hits[0]) { event.preventDefault(); open(hits[0]); }
            else if (event.key === "ArrowDown") {
              event.preventDefault();
              event.currentTarget.closest("[data-find]")?.querySelector<HTMLElement>("[data-hit]")?.focus();
            } else if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            } else if (event.key === "Escape") {
              // An empty box lets Esc go on to close the chapters where they're over the code.
              event.currentTarget.blur();
            }
          }}
          placeholder="Find in review"
          aria-label="Find in review"
          className="h-8 pl-7 pr-7 text-xs pointer-coarse:h-9 max-md:pointer-coarse:h-9"
        />
        {!query && <kbd aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1 font-mono text-[10px] leading-4 text-subtle-foreground max-md:pointer-coarse:hidden">/</kbd>}
      </label>
      </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
      {/* Hidden, not unmounted, so the chapters keep what's open and All files its filter. */}
      <div hidden={!!query.trim()}>{children}</div>
      {query.trim() && (
        <div className="space-y-1.5">
          <p role="status" className="px-2 text-[11px] text-muted-foreground">
            {!active ? "Searching…" : total === 0 ? "Nothing in this review matches." : `${total.toLocaleString()} result${total === 1 ? "" : "s"}${total > hits.length ? `, the first ${hits.length}` : ""}`}
          </p>
          {hits.length > 0 && (
            <ul aria-label="Results" className="space-y-px">
              {hits.map((hit, index) => (
                <li key={index}>
                  <button
                    type="button"
                    data-hit
                    onClick={() => open(hit)}
                    onKeyDown={(event) => moveFocus(event, box.current)}
                    className="w-full rounded-md px-2 py-1 text-left hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none pointer-coarse:min-h-11"
                  >
                    {hit.kind === "line" ? (
                      <>
                        <span className="flex min-w-0 font-mono text-[11px]" title={`${hit.file}:${hit.line}`}>
                          <span className="min-w-0 truncate text-muted-foreground">{hit.file.slice(0, hit.file.lastIndexOf("/") + 1)}</span>
                          <span className="shrink-0 text-foreground">{hit.file.slice(hit.file.lastIndexOf("/") + 1)}:{hit.line}</span>
                          {hit.side === "LEFT" && <span className="ml-1 shrink-0 text-destructive-text">removed</span>}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground"><Snippet text={hit.text} at={hit.at} length={searched.length} /></span>
                      </>
                    ) : (
                      <>
                        <span className="flex min-w-0 gap-1 text-[11px] text-muted-foreground">
                          <Icon name={hit.kind === "summary" ? "FileText" : "Route"} className="mt-px size-3 shrink-0" aria-hidden />
                          {hit.kind === "summary" ? <span className="min-w-0 truncate font-mono">{hit.file}</span> : <span className="min-w-0 truncate">Chapter: <InlineCode text={titles.get(hit.chapterId) ?? ""} /></span>}
                        </span>
                        <span className="block truncate text-xs text-foreground/90"><Snippet text={hit.text} at={hit.at} length={searched.length} /></span>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      </div>
    </div>
  );
});
FindInReview.displayName = "FindInReview";
