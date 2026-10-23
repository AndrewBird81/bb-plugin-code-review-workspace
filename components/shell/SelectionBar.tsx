import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { LineSelection } from "../../lib/remount";
import { useKnob } from "../../lib/settings";
import { cn } from "../../lib/utils";
import { OVERVIEW, useWorkspace } from "../../lib/workspace-context";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { useMediaQuery } from "../ui/hooks/use-media-query";
import { Icon } from "../ui/icon";

/** Up from `el`, through the shadow roots pierre draws code in, to the first element that matches `selector`. */
function closestAcross(el: Element | null, selector: string): HTMLElement | null {
  for (let at = el; at; at = at.parentElement ?? (at.getRootNode() as Partial<ShadowRoot>).host ?? null) {
    if (at.matches(selector)) return at as HTMLElement;
  }
  return null;
}

/** The text selected in one of the diff's files inside `root`, and its file; null for none, or for text in a comment. */
function selectedCode(root: Element): { file: string; code: string } | null {
  const selection = document.getSelection();
  const code = selection?.toString() ?? "";
  if (!selection?.rangeCount || !code.trim()) return null;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  const file = closestAcross(el, "[data-file]");
  // Text in a draft comment or the comment box isn't code to ask about.
  if (!file || !root.contains(file) || closestAcross(el, "[data-draft-at]")) return null;
  return { file: file.dataset.file!, code: code.slice(0, 4000) };
}

/** How long the text's bar stays once its selection goes: a tap on the bar can clear the selection before its click. */
const TEXT_GONE_MS = 300;

/**
 * What's selected in the diff, with what you can do with it: lines picked GitHub-style, with a mouse or by tapping
 * them, or text selected in the code, as a long-press selects it on a phone or iPad (followed with `selectionchange`,
 * which touch selection fires, unlike mouseup). It sits at the bottom of the workspace, at the code's right; on a
 * `phone` the lines' bar takes the dock's place, and the text's sits above it. Lines GitHub takes no comment on, picked in
 * rendered Markdown, offer Ask agent alone.
 */
export function SelectionBar({ lines, phone, onComment, onAskLines, onClear }: {
  lines: LineSelection | null;
  phone: boolean;
  onComment: () => void;
  onAskLines: () => void;
  onClear: () => void;
}) {
  const { activeId, askAgent, layout } = useWorkspace();
  const coarse = useMediaQuery("(pointer: coarse)");
  const askAboutSelection = useKnob("askAboutSelection");
  const ref = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<{ file: string; code: string } | null>(null);
  useEffect(() => {
    let gone: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const root = ref.current?.parentElement;
      const selected = root ? selectedCode(root) : null;
      clearTimeout(gone);
      if (selected) setText((shown) => shown?.file === selected.file && shown.code === selected.code ? shown : selected);
      else gone = setTimeout(() => setText(null), TEXT_GONE_MS);
    };
    document.addEventListener("selectionchange", update);
    return () => {
      clearTimeout(gone);
      document.removeEventListener("selectionchange", update);
    };
  }, []);
  // A selection's actions go with the chapter it was made in.
  useEffect(() => setText(null), [activeId]);
  // Not over a side over the code, which dims it, nor over a phone's sheet, as a fold can open one with lines selected.
  const over = layout.nav === "overlay" || layout.panel === "overlay";
  const shown = over ? null : lines ? "lines" : text && askAboutSelection ? "text" : null;

  // At the code's right edge, clear of the panel docked beside it, and of the fold of a foldable held open.
  const [edge, setEdge] = useState<{ left: number; right: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const root = ref.current?.parentElement;
    const main = root?.querySelector("main");
    if (!shown || phone || !root || !main) return;
    const place = () => {
      const outer = root.getBoundingClientRect();
      const box = main.getBoundingClientRect();
      const next = { left: box.left - outer.left, right: outer.right - box.right, width: box.width };
      setEdge((was) => was?.left === next.left && was.right === next.right && was.width === next.width ? was : next);
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(main);
    return () => observer.disconnect();
  }, [shown, phone, layout]);

  const askText = () => {
    if (!text) return;
    askAgent({ file: text.file, code: text.code, ...(activeId !== OVERVIEW ? { chapterId: activeId } : {}) });
    setText(null);
    document.getSelection()?.removeAllRanges();
  };
  // A phone's bar keeps to its width: the file's name and lines get what the buttons leave.
  const button = cn("h-8 shrink-0 text-xs", phone ? "gap-1 px-1.5" : "gap-1.5 px-2", TOUCH_CONTROL);
  const label = (file: string, at?: string) => (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      {!phone && <Icon name="File" className="size-3.5 shrink-0" aria-hidden />}
      <span className="truncate">{file.split("/").pop()}</span>
      {at && <span className="shrink-0 rounded bg-primary/10 px-1 text-primary">{at}</span>}
    </span>
  );
  // Why lines in rendered Markdown take no comment, or on touch how to make a range: under the bar on a phone, beside the lines elsewhere.
  const hint = lines?.askOnly ? "GitHub only takes comments on changed sections" : lines && coarse ? "Tap another line to select a range" : null;
  const first = lines ? Math.min(lines.range.start, lines.range.end) : 0;
  const last = lines ? Math.max(lines.range.start, lines.range.end) : 0;
  // Beside a docked panel in under 600px of code on touch, as beside Comments on an unfolded iPhone Duo held sideways,
  // the fold (x 455–496 of the code's 0–560) runs through its right part: the bar keeps to the code's left, short of it.
  const besideFold = coarse && layout.panel === "docked" && !!edge && edge.width < 600;
  const place: CSSProperties | undefined = phone || !edge ? undefined
    : besideFold ? { left: edge.left + 16, right: "auto", maxWidth: Math.min(edge.width - 32, 420) }
    : { right: edge.right ? edge.right + 16 : "max(16px, var(--gr-safe-right, 0px))", maxWidth: edge.width > 64 ? edge.width - 32 : undefined };
  return (
    <div ref={ref} className="contents">
      {shown && (
        <div
          role="group"
          aria-label="Selection"
          style={place}
          className={cn(
            "absolute z-[62] flex flex-col rounded-xl border border-border bg-popover p-1 text-xs shadow-2xl ring-1 ring-primary/10",
            !phone ? "bottom-[max(16px,var(--gr-safe-bottom,0px))] right-4 w-max max-w-[calc(100%-32px)]"
              // Each side clear of what of its safe area reaches the workspace (lib/use-safe-area.ts): its padding doesn't
              // move what's absolute in it.
              : "left-[calc(6px+var(--gr-safe-left,0px))] right-[calc(6px+var(--gr-safe-right,0px))]",
            phone && (shown === "lines" ? "bottom-[calc(4px+var(--gr-safe-bottom,0px))]"
              // Above the dock (52px and the safe area under it), which stays while text is selected.
              : "bottom-[calc(60px+var(--gr-safe-bottom,0px))]"),
          )}
        >
          <div className="flex min-w-0 items-center gap-1">
            {lines ? <>
              <span className="flex min-w-0 flex-1 flex-col px-1.5">
                {label(lines.file, `L${first}${last !== first ? `–${last}` : ""}`)}
                {hint && !phone && <span className="truncate text-[11px] text-muted-foreground">{hint}</span>}
              </span>
              {!lines.askOnly && <Button size="sm" variant="ghost" className={button} onClick={onComment}>
                <Icon name="MessageSquarePlus" className="size-3.5 text-primary" aria-hidden />
                Comment
              </Button>}
              <Button size="sm" variant="ghost" className={button} onClick={onAskLines}>
                <Icon name="Sparkles" className="size-3.5 text-(--ansi-13)" aria-hidden />
                Ask agent
              </Button>
              <Button size="sm" variant="ghost" aria-label="Clear selection" className={cn(button, "w-8 px-0 text-muted-foreground")} onClick={onClear}>
                <Icon name="X" className="size-3.5" aria-hidden />
              </Button>
            </> : text && <>
              <span className="flex min-w-0 flex-1 px-1.5">{label(text.file)}</span>
              {/* Pressed, the button keeps the selection: it's what it asks about. */}
              <Button size="sm" variant="ghost" className={button} onPointerDown={(event) => event.preventDefault()} onClick={askText}>
                <Icon name="Sparkles" className="size-3.5 text-(--ansi-13)" aria-hidden />
                Ask agent about selection
              </Button>
              <Button size="sm" variant="ghost" aria-label="Clear selection" className={cn(button, "w-8 px-0 text-muted-foreground")} onClick={() => { setText(null); document.getSelection()?.removeAllRanges(); }}>
                <Icon name="X" className="size-3.5" aria-hidden />
              </Button>
            </>}
          </div>
          {hint && phone && <p className="px-2 pb-1 text-[11px] text-muted-foreground">{hint}</p>}
        </div>
      )}
    </div>
  );
}
