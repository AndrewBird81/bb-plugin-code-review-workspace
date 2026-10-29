import { useId, useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import type { PostButton, PostShown } from "../src/post-preview";
import { usePortalScopeProps } from "../lib/portal-scope";
import { cn } from "../lib/utils";
import { TOUCH_CONTROL } from "./touch";
import { Badge, type Tone } from "./ui/badge";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

/** A button that's busy: aria-disabled, so it keeps the focus, and drawn as a disabled one (as Submit's). */
const BUSY = "aria-disabled:pointer-events-none aria-disabled:bg-muted/60 aria-disabled:text-subtle-foreground aria-disabled:shadow-none";
/** What each button does, in the tone DESIGN.md gives it: an approval reads as one at a glance. */
const LOOK: Record<PostButton, { tone: Tone; busy: string; cancel: string }> = {
  Post: { tone: "neutral", busy: "Posting…", cancel: "Don’t post" },
  Approve: { tone: "success", busy: "Approving…", cancel: "Don’t approve" },
  "Request changes": { tone: "warning", busy: "Requesting changes…", cancel: "Don’t request changes" },
  Merge: { tone: "merged", busy: "Merging…", cancel: "Don’t merge" },
  Close: { tone: "danger", busy: "Closing…", cancel: "Don’t close" },
  Apply: { tone: "neutral", busy: "Applying…", cancel: "Don’t apply" },
};

/** Whether a form's payload is a PostShown, as the server sends it. */
function isShown(payload: unknown): payload is PostShown {
  const p = payload as PostShown | null;
  return !!p && typeof p.title === "string" && typeof p.action === "string" && Array.isArray(p.parts) && Array.isArray(p.notes) && p.button in LOOK;
}

/**
 * The Post form, in place of the review agent's message box while it waits: what it does, where and as whom, then
 * exactly the text that posts, as written (raw, so nothing in it hides from you), or how a merge or close is done, and
 * one button naming it: Post, Approve, Request changes, Merge, Close. Don't post closes it; a "yes" typed in chat
 * instead posts it too, and closes it.
 */
export function PostPreview({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const titleId = useId();
  // BB draws the form in its own composer, outside the plugin's mount: it carries its own scope for the plugin's styles.
  const scope = usePortalScopeProps();
  const [busy, setBusy] = useState<"post" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = isShown(interaction.payload) ? interaction.payload : null;
  const look = shown ? LOOK[shown.button] : null;
  const act = async (which: "post" | "cancel") => {
    if (busy) return;
    setBusy(which);
    setError(null);
    try { await (which === "post" ? submit({ post: true }) : cancel()); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't go through. Try again."); setBusy(null); }
  };
  return (
    <section {...scope} aria-labelledby={titleId} className="flex max-h-[min(60vh,32rem)] min-w-0 flex-col rounded-lg border border-border bg-card text-card-foreground">
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-2">
        <Icon name="Github" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 id={titleId} className="min-w-0 flex-1 break-words text-sm font-medium">{shown?.title ?? interaction.title}</h2>
        {shown && look && <Badge tone={look.tone} className="shrink-0">{shown.action}</Badge>}
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {shown ? <>
          {shown.notes.map((note, index) => <p key={index} className="flex gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-xs leading-relaxed text-warning-text"><Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" aria-hidden />{note}</p>)}
          {!!shown.details?.length && <ul className="list-disc space-y-1 pl-5 text-sm marker:text-muted-foreground">{shown.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}
          {shown.parts.length > 0 && <p className="text-xs text-muted-foreground">Exactly what posts:</p>}
          {shown.parts.map(({ label, body, path }, index) => <figure key={index} className="space-y-1">
            <figcaption className={cn("text-xs text-muted-foreground", path ? "break-all font-mono" : "font-medium")}>{label}</figcaption>
            <p className="whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2 py-1.5 text-sm leading-relaxed">{body}</p>
          </figure>)}
        </> : <p className="text-sm text-muted-foreground">This form couldn't be read. Don't post it: ask the agent to show it again.</p>}
      </div>
      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-3 py-2">
        {error && <p role="alert" className="mr-auto text-xs text-destructive-text">{error}</p>}
        <Button variant="ghost" size="sm" className={TOUCH_CONTROL} aria-disabled={busy !== null || undefined} onClick={() => void act("cancel")}>{look?.cancel ?? "Don’t post"}</Button>
        {shown && look && <Button size="sm" className={cn("gap-1.5", TOUCH_CONTROL, BUSY)} aria-disabled={busy !== null || undefined} onClick={() => void act("post")}>
          {busy === "post" && <Icon name="Loading" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}
          {busy === "post" ? look.busy : shown.button}
        </Button>}
      </footer>
    </section>
  );
}
