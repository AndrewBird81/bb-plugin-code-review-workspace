// For tests, not the plugin: the draft's provider with Comments and Finish review after what it wraps, both showing, in
// a workspace of their own, as the side panel shows them one at a time. Import it after the plugin runtime is installed.
import { useEffect, type ReactNode } from "react";
import type { CommentLocation } from "../src/draft";
import type { ReviewItem } from "../lib/review-state";
import { holdReview } from "../lib/review-holds";
import { OVERVIEW, WorkspaceProvider, type WorkspaceApi } from "../lib/workspace-context";
import { DraftProvider, type DraftProviderProps } from "./DraftProvider";
import { CommentsView } from "./comments/CommentsView";
import { FinishView } from "./comments/FinishView";
import { dropComments, updateComments } from "./comments/store";

const noop = () => {};
const later = async () => {};

/** A workspace for views tested without the review around them; `over` replaces any part. */
export function testWorkspace(targetKey: string, over: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    targetKey, review: { targetKey, kind: "pr" }, guide: { title: "Guide", intent: "", sections: [], unplacedFiles: [] } as unknown as WorkspaceApi["guide"], sections: [], activeId: OVERVIEW, go: noop,
    layout: { mode: "tablet", nav: "closed", panel: "docked", navCanDock: true, panelCanDock: true, narrowReader: false, widePane: true, phoneResized: false },
    nav: { open: false, toggle: noop, find: noop, view: "chapters", setView: noop },
    panel: { view: "comments", open: noop, toggle: noop, close: noop },
    files: { views: new Map(), toggleViewed: noop, markChapterViewed: noop, nextUnviewed: noop, foldAll: noop },
    compare: { baseline: null, head: null, from: null, pick: noop, since: null, narrowed: false, setNarrowed: noop, error: null, what: "your review" },
    display: { layout: "unified", toggleLayout: noop, newFiles: "file", setNewFiles: noop, markdownFiles: "source", setMarkdownFiles: noop, unifiedOnly: false, wrap: false, setWrap: noop, hideWhitespace: false, setHideWhitespace: noop, githubThreads: true, setGithubThreads: noop, commentsFolded: false, setCommentsFolded: noop },
    reveal: noop, showLocation: noop, followUp: noop, askAgent: noop, openFinish: noop,
    fullscreen: { available: false, on: false, toggle: noop }, leave: later,
    snooze: later, newCommits: false, rebuild: later, reload: later, pinnable: false, showShortcuts: noop, shortcuts: true, mainThread: null,
    ...over,
  };
}

/**
 * The draft as the side panel shows it: Comments' list and Finish review. Its chapters are one, of `files`, in their
 * order; `onShowComment` is where a comment chosen in the list goes. GitHub has answered, with nothing.
 */
export function DraftTray({ children, workspace, onShowComment, ...props }: DraftProviderProps & { children?: ReactNode; workspace?: Partial<WorkspaceApi>; onShowComment?: (at: CommentLocation) => void }) {
  const { targetKey } = props;
  const files = props.files ?? props.activeFiles;
  updateComments(targetKey, { loaded: true });
  // As the workspace does when the review's last one goes: the next review starts with nothing open or filtered.
  useEffect(() => holdReview("threads", targetKey, () => dropComments(targetKey)), [targetKey]);
  const api = testWorkspace(targetKey, {
    review: (props.review ?? { targetKey, kind: props.isLocal ? "ref" : "pr" }) as ReviewItem,
    sections: [{ id: "c1", title: "Chapter", overview: "", diffs: files.map((file) => ({ file })) }],
    reveal: onShowComment ?? noop,
    ...workspace,
  });
  return (
    <WorkspaceProvider api={api}>
      <DraftProvider {...props}>
        {children}
        <CommentsView shown finish={false} tab="drafts" onTab={noop} revision={props.reviewRevision ?? ""} onShowThread={noop} />
        <FinishView shown revision={props.reviewRevision ?? ""} />
      </DraftProvider>
    </WorkspaceProvider>
  );
}
