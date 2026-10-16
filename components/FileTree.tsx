import { memo, useContext, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { composing } from "../lib/composing";
import { cn } from "../lib/utils";
import { fileTree, filterPaths, firstFile, type TreeNode } from "../lib/file-tree";
import type { FileInterdiff } from "../src/interdiff";
import type { ReviewThread } from "../src/threads";
import type { FileOwners } from "../src/codeowners";
import type { FileViewFlags } from "./DiffViewer";
import { draftState } from "../lib/comments";
import { InlineDraftContext } from "./InlineDraft";
import { FileTag } from "./FileTag";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";

/** Moves focus to the row above or below, or back to the filter from the first. */
function moveFocus(event: KeyboardEvent<HTMLElement>, filter: HTMLInputElement | null) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const rows = Array.from(event.currentTarget.closest("[data-file-tree]")?.querySelectorAll<HTMLElement>("[data-tree-row]") ?? []);
  const at = rows.indexOf(event.target as HTMLElement);
  const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];
  if (next) next.focus();
  else if (event.key === "ArrowUp") filter?.focus();
}

/** How many of the items are on each file. */
function count(list: readonly { file?: string | null; path?: string | null }[] | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of list ?? []) {
    const file = item.file ?? item.path;
    if (file) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/**
 * Every changed file as a folder tree, with a path filter. Each file says whether it's viewed, its draft
 * comments and discussions, whether it changed since your review, its kind, and its CODEOWNERS owners.
 */
export const FileTree = memo(function FileTree({
  chapterOf,
  views,
  onSelectFile,
  currentFile,
  since,
  threads,
  owners,
  generated,
  sinceWhat,
}: {
  /** Each file in the review, in the guide's order, and its chapter. */
  chapterOf: ReadonlyMap<string, string>;
  views: Map<string, FileViewFlags>;
  onSelectFile: (chapterId: string, file: string) => void;
  currentFile?: string;
  since?: Map<string, FileInterdiff> | null;
  /** Everyone's GitHub threads on the PR. */
  threads?: readonly ReviewThread[];
  owners?: ReadonlyMap<string, FileOwners>;
  generated?: ReadonlySet<string>;
  /** What `since` compares with: "your review", or a commit. */
  sinceWhat: string;
}) {
  const draft = useContext(InlineDraftContext);
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const filterRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => filterPaths([...chapterOf.keys()], filter), [chapterOf, filter]);
  const tree = useMemo(() => fileTree(shown), [shown]);
  // Hidden nits count nowhere, as in the file's header; a nit on an older diff holds Submit, so it isn't hidden.
  const comments = useMemo(() => count(draft?.comments.filter((c) => !(draft.hideNits && c.severity === "nit" && draftState(c, draft.stale) !== "older-diff"))), [draft?.comments, draft?.stale, draft?.hideNits]);
  const discussions = useMemo(() => count(draft?.discussions), [draft?.discussions]);
  const openThreads = useMemo(() => count(threads?.filter((thread) => !thread.isResolved)), [threads]);

  const open = (file: string) => onSelectFile(chapterOf.get(file)!, file);

  function row(node: TreeNode, depth: number) {
    const indent = { paddingLeft: 6 + depth * 12 };
    if (node.kind === "folder") {
      // A filter shows every folder it matches into.
      const expanded = !!filter.trim() || !closed[node.path];
      return (
        <li key={node.path}>
          <button
            type="button"
            data-tree-row
            aria-expanded={expanded}
            onClick={() => setClosed((c) => ({ ...c, [node.path]: expanded }))}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setClosed((c) => ({ ...c, [node.path]: event.key === "ArrowLeft" }));
              } else moveFocus(event, filterRef.current);
            }}
            className="flex w-full items-center gap-1 rounded-md py-1 pr-1.5 text-left text-subtle-foreground hover:bg-state-hover hover:text-foreground pointer-coarse:min-h-11"
            style={indent}
          >
            <Icon name="ChevronDown" className={cn("size-3 shrink-0 transition-transform duration-150", !expanded && "-rotate-90")} aria-hidden />
            <Icon name={expanded ? "FolderOpen" : "Folder"} className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate font-mono text-[11px]">{node.name}</span>
          </button>
          {expanded && <ul>{node.children.map((child) => row(child, depth + 1))}</ul>}
        </li>
      );
    }
    const file = node.path;
    const viewed = views.get(file)?.viewed ?? false;
    const current = file === currentFile;
    const drafted = comments.get(file) ?? 0;
    const talk = (discussions.get(file) ?? 0) + (openThreads.get(file) ?? 0);
    const change = since?.get(file)?.status;
    const changed = change === "changed" || change === "added";
    const owned = owners?.get(file);
    const talkLabel = [openThreads.get(file) ? plural(openThreads.get(file)!, "open GitHub thread") : "", discussions.get(file) ? plural(discussions.get(file)!, "discussion") + " with the agent" : ""].filter(Boolean).join(", ");
    return (
      <li key={file}>
        <button
          type="button"
          data-tree-row
          onClick={() => open(file)}
          onKeyDown={(event) => moveFocus(event, filterRef.current)}
          aria-current={current ? "true" : undefined}
          className={cn("flex w-full items-start gap-1.5 rounded-md py-1 pr-1.5 text-left hover:bg-state-hover pointer-coarse:min-h-11 pointer-coarse:items-center", current && "bg-state-hover")}
          style={indent}
          title={file}
        >
          <Icon
            name={viewed ? "CircleCheck" : "File"}
            className={cn("mt-px size-3.5 shrink-0", viewed ? "text-diff-added" : current ? "text-primary" : "text-subtle-foreground")}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className={cn(
                "min-w-0 flex-1 truncate font-mono text-[11px]",
                viewed ? "text-muted-foreground line-through decoration-muted-foreground/40" : current ? "text-primary" : "text-foreground/90",
              )}>{node.name}</span>
              {viewed && <span className="sr-only">viewed</span>}
              {changed && (
                <span className="size-1.5 shrink-0 rounded-full bg-primary" title={`${change === "added" ? "Added" : "Changed"} since ${sinceWhat}`}>
                  <span className="sr-only">{change === "added" ? "added" : "changed"} since {sinceWhat}</span>
                </span>
              )}
              {drafted > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-primary" title={plural(drafted, "draft comment")}>
                  <Icon name="MessageSquare" className="size-3" aria-hidden /><span aria-hidden>{drafted}</span><span className="sr-only">{plural(drafted, "draft comment")}</span>
                </span>
              )}
              {talk > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground" title={talkLabel}>
                  <Icon name="BubbleChatQuestion" className="size-3" aria-hidden /><span aria-hidden>{talk}</span><span className="sr-only">{talkLabel}</span>
                </span>
              )}
              <FileTag file={file} generated={generated?.has(file)} />
            </span>
            {owned && (
              <span className={cn("mt-0.5 flex items-center gap-1 text-[10px]", owned.mine ? "text-primary" : "text-subtle-foreground")} title={`CODEOWNERS: ${owned.owners.join(", ")}`}>
                <Icon name="UserRound" className="size-3 shrink-0" aria-hidden />
                <span className="min-w-0 truncate font-mono">{owned.owners.join(" ")}</span>
                {owned.mine && <span className="shrink-0 font-medium">· yours</span>}
              </span>
            )}
          </span>
        </button>
      </li>
    );
  }

  return (
    <div data-file-tree className="space-y-1.5">
      {/* A label, so a tap just above or below the box, within its 44px target on a coarse pointer, still lands in it. */}
      <label className="relative block px-1 pointer-coarse:py-1">
        <Icon name="Search" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground" aria-hidden />
        <Input
          ref={filterRef}
          data-filter-box
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (composing(event)) return;
            if (event.key === "Enter" && shown.length) { event.preventDefault(); open(firstFile(tree)!); }
            else if (event.key === "ArrowDown") {
              event.preventDefault();
              event.currentTarget.closest("[data-file-tree]")?.querySelector<HTMLElement>("[data-tree-row]")?.focus();
            } else if (event.key === "Escape" && filter) { event.preventDefault(); setFilter(""); }
          }}
          placeholder="Filter files"
          aria-label="Filter files"
          className="h-7 pl-7 text-xs pointer-coarse:h-9 max-md:pointer-coarse:h-9"
        />
      </label>
      {filter.trim() && <p className="px-2 text-[11px] text-muted-foreground" role="status">{shown.length ? `${plural(shown.length, "file")} of ${chapterOf.size}` : "No files match."}</p>}
      <ul aria-label="All files" className="space-y-px">{tree.map((node) => row(node, 0))}</ul>
    </div>
  );
});
FileTree.displayName = "FileTree";
