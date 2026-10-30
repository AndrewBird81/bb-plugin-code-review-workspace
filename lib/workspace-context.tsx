// The review workspace's state and commands, for the views inside it (useWorkspace) and for BB's title bar outside it
// (useWorkspaceFor, through the store), so panels can mount anywhere without the workspace passing props down.
import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { DockInjection } from "../components/AgentDock";
import type { FileViewFlags } from "../components/DiffViewer";
import type { CommentLocation } from "../src/draft";
import type { Guide } from "../src/guide";
import type { FileInterdiff } from "../src/interdiff";
import type { AgentMessageContext } from "../src/store";
import type { NavView, PanelView, SideView } from "./panel-state";
import type { ReviewPreferences } from "./review-preferences";
import type { ReviewItem } from "./review-state";
import type { WorkspaceLayout } from "./workspace-layout";
import { publishWorkspace } from "./workspace-store";

/** A chapter as the workspace shows it: the guide's, or Other files, for changed files the guide doesn't place. */
export type Chapter = Pick<Guide["sections"][number], "id" | "title" | "overview" | "risk" | "focus"> & {
  diffs: Array<{ file: string; summary?: string; hunks?: number[] }>;
};

type Side = CommentLocation["side"];

export interface WorkspaceApi {
  targetKey: string;
  review: ReviewItem;
  guide: Guide;
  /** The guide's chapters, then Other files for changed files they don't list. */
  sections: Chapter[];
  /** The chapter showing, or OVERVIEW. */
  activeId: string;
  /** Show a chapter, from its intro, or the Overview. */
  go(id: string): void;
  /** Where the navigator and the side panel are, from the workspace's own size. */
  layout: WorkspaceLayout;
  /** The chapters and files beside the code. `open`: it shows, docked or over the code. */
  nav: {
    open: boolean;
    toggle(): void;
    /** Show it with Find in review's box focused. */
    find(): void;
    view: NavView;
    setView(view: NavView): void;
  };
  /** The side panel. `view` is the one showing, docked or over the code; null while it's closed. */
  panel: { view: SideView | null; open(view: PanelView): void; toggle(view: PanelView): void; close(): void };
  files: {
    views: Map<string, FileViewFlags>;
    toggleViewed(file: string, viewed: boolean): void;
    /** Mark every file in a chapter viewed. */
    markChapterViewed(id: string): void;
    /** Open the next file not viewed yet, after the one you're on, in any chapter (u). */
    nextUnviewed(): void;
    /** Fold or unfold every file of the chapter in the diff. */
    foldAll(folded: boolean): void;
  };
  /** Which pushes the diff shows: all of the PR, or what changed since your review or a commit you picked. */
  compare: {
    /** Your last review's commit, and the PR's head. */
    baseline: string | null;
    head: string | null;
    /** A commit picked to compare from, instead of your last review. */
    from: string | null;
    pick(sha: string | null): void;
    /** Each file's change since then, once loaded; null when there's nothing to compare. */
    since: Map<string, FileInterdiff> | null;
    /** The diff shows only what changed since then. */
    narrowed: boolean;
    setNarrowed(narrowed: boolean): void;
    error: string | null;
    /** "your review", or the picked commit's short sha. */
    what: string;
  };
  /** How the diff draws. */
  display: {
    layout: ReviewPreferences["diffLayout"];
    toggleLayout(): void;
    /** How a new or deleted file draws, saved for every review like the layout. */
    newFiles: ReviewPreferences["newFiles"];
    setNewFiles(show: ReviewPreferences["newFiles"]): void;
    /** How a Markdown file opens, saved for every review like the layout. */
    markdownFiles: ReviewPreferences["markdownFiles"];
    setMarkdownFiles(show: ReviewPreferences["markdownFiles"]): void;
    /** The pane is too narrow for split, so the diff shows unified whatever the layout. */
    unifiedOnly: boolean;
    wrap: boolean;
    setWrap(wrap: boolean): void;
    hideWhitespace: boolean;
    setHideWhitespace(hide: boolean): void;
    /** GitHub's threads show under their lines. */
    githubThreads: boolean;
    setGithubThreads(show: boolean): void;
    /** Comments in the code show as one-line markers. */
    commentsFolded: boolean;
    setCommentsFolded(folded: boolean): void;
  };
  /** Show a comment's line in the diff, switching chapters as needed. */
  reveal(at: CommentLocation): void;
  /** Show a line in the whole diff, or the file for a null line. A file the PR no longer changes offers its GitHub link instead. */
  showLocation(file: string, line: number | null, side: Side, url?: string | null): void;
  /** Show a thread's line with a comment box open there, to follow up on it. */
  followUp(file: string, line: number | null, side: Side, url?: string | null): void;
  /** Open the agent; its next message is about `context`, or else the file you're on, or quotes `quote` as it is. */
  askAgent(context?: AgentMessageContext, quote?: string): void;
  /** Open the draft at its summary. `replaced`: you agreed the agent's summary replaces the one you were writing. */
  openFinish(replaced?: boolean): void;
  /** `toggle` must run inside the click: a browser goes full screen only from one. */
  fullscreen: { available: boolean; on: boolean; toggle(): void };
  /** Go to All reviews, or to another of the panel's pages (`subPath`), leaving full screen first. */
  leave(subPath?: string): Promise<void>;
  snooze(snoozed: boolean, until?: number): Promise<void>;
  /** The PR has commits the guide wasn't written for. */
  newCommits: boolean;
  /** Write the guide again, as for new commits. */
  rebuild(): Promise<void>;
  /** Read the review, guide and diff again. */
  reload(): Promise<void>;
  /** Reviews show in BB's thread list, so they can be pinned there. */
  pinnable: boolean;
  showShortcuts(): void;
  /** Single-key shortcuts are on (Settings → Reading). */
  shortcuts: boolean;
  /**
   * The review's main thread, which its Sends go to, while Send to thread is on (src/loop.ts): its title and machine
   * once the server says; null for none.
   */
  mainThread: MainThreadName | null;
  /** The review's patch, which the agent quotes selected lines from. */
  patch: string;
  /** The last ask for the agent (askAgent), which the Review agent tab takes once. */
  injection?: DockInjection;
  /** The review's id and name (lib/review-identity.ts), `api#4512` and "Fix login race". */
  reviewId?: string;
  reviewName?: string;
}

/** The thread a review's Sends go to, by its title and machine as the server last said: null until it does. */
export interface MainThreadName { threadId: string; title: string | null; machine: string | null }

/** The `activeId` of the review's Overview, which comes before its chapters. */
export const OVERVIEW = "overview";
/** The `activeId` of Not pushed yet, after the chapters: what a PR's review's folder has that GitHub doesn't. */
export const NOT_PUSHED_PAGE = "not-pushed";

const WorkspaceContext = createContext<WorkspaceApi | null>(null);

/** Gives the workspace's views its api, and BB's title bar too, through the store. */
export function WorkspaceProvider({ api, children }: { api: WorkspaceApi; children: ReactNode }) {
  useEffect(() => publishWorkspace(api), [api]);
  return <WorkspaceContext.Provider value={api}>{children}</WorkspaceContext.Provider>;
}

/** Gives a view outside the workspace's tree, such as a tab in BB's side panel, the workspace's api from the store. */
export function WorkspaceView({ api, children }: { api: WorkspaceApi; children: ReactNode }) {
  return <WorkspaceContext.Provider value={api}>{children}</WorkspaceContext.Provider>;
}

/** The workspace this view is in. */
export function useWorkspace(): WorkspaceApi {
  const api = useContext(WorkspaceContext);
  if (!api) throw new Error("useWorkspace() is only for views inside a review's workspace.");
  return api;
}
