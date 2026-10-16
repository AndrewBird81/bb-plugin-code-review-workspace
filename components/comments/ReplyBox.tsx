import { useEffect, useRef, useState, type FocusEvent, type RefObject } from "react";
import type { ThreadItem } from "../../lib/comments";
import { REPLY_DRAFT_LABEL } from "../../lib/comments";
import { setReplyWriting } from "../../lib/comments-fold";
import { linkImages } from "../../lib/link-images";
import { cn } from "../../lib/utils";
import { CommentBody, composerKeys } from "../InlineDraft";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Textarea } from "../ui/textarea";
import type { CommentActions } from "./store";
import { notSubmitted } from "./look";

// Text typed in a reply box and not saved yet, by review and thread: a card that goes and comes back, such as a row
// that moves to another group, or the list's copy of a card in the code, picks it up.
const unsaved = new Map<string, string>();

/**
 * A thread's reply, inside its card as a dashed box: the reply drafted on the server (yours or the agent's), or one
 * you're writing. Send reply posts it now; what you write is kept as the thread's draft when you leave the box.
 */
export function ReplyBox({ targetKey, item, where, actions, busy, writing, onClose, replyButton }: {
  targetKey: string;
  item: ThreadItem;
  /** "src/a.ts:2", for the box's name. */
  where: string;
  actions: CommentActions;
  /** A reply or resolve is being sent on this thread. */
  busy: boolean;
  /** You chose Reply: the box is open to write in. */
  writing: boolean;
  /** The box closed: sent, discarded, or left empty. */
  onClose: () => void;
  /** Reply, which takes the focus back when the box closes. */
  replyButton: RefObject<HTMLButtonElement | null>;
}) {
  const key = `${targetKey}:${item.id}`;
  const draft = item.replyDraft?.body ?? "";
  const [text, setText] = useState(() => unsaved.get(key) ?? draft);
  const [editing, setEditing] = useState(writing || unsaved.has(key));
  // The reply as last saved; a newer draft from the server replaces the text only while it isn't edited.
  const saved = useRef(draft);
  useEffect(() => {
    setText((current) => (current === saved.current && !unsaved.has(key) ? draft : current));
    saved.current = draft;
  }, [draft, key]);
  useEffect(() => {
    if (!writing) return;
    // A drafted reply shown already, as r opens it: its box takes the focus too.
    focusBox.current = true;
    setEditing(true);
  }, [writing]);
  // While you write, folding comments leaves the card open.
  useEffect(() => {
    if (!editing) return;
    setReplyWriting(targetKey, item.id, true);
    return () => setReplyWriting(targetKey, item.id, false);
  }, [editing, targetKey, item.id]);
  const box = useRef<HTMLTextAreaElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const focusBox = useRef(writing);
  useEffect(() => {
    if (!editing || !focusBox.current) return;
    focusBox.current = false;
    const el = box.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  // Send and Discard settle the draft themselves; otherwise text left unsaved is saved as the box goes.
  const settling = useRef(false);
  const live = useRef({ text, actions });
  live.current = { text, actions };
  useEffect(() => () => {
    const { text, actions } = live.current;
    if (!settling.current && unsaved.has(key) && text !== saved.current) {
      unsaved.delete(key);
      actions.saveReplyDraft(item.id, text);
    }
  }, [key, item.id]);

  function change(next: string) {
    setText(next);
    if (next !== saved.current) unsaved.set(key, next);
    else unsaved.delete(key);
  }
  function save(event: FocusEvent<HTMLTextAreaElement>) {
    // This box's own buttons settle the draft themselves.
    const related = event.relatedTarget as HTMLElement | null;
    if (related?.dataset.replyAction && card.current?.contains(related)) return;
    if (text === saved.current) { unsaved.delete(key); return; }
    saved.current = text;
    unsaved.delete(key);
    actions.saveReplyDraft(item.id, text);
  }
  function close() {
    setEditing(false);
    onClose();
    requestAnimationFrame(() => replyButton.current?.focus());
  }
  async function send() {
    const body = text.trim();
    if (!body) return;
    settling.current = true;
    try {
      if (await actions.reply(item.id, body)) {
        unsaved.delete(key);
        saved.current = "";
        setText("");
        close();
      } else if (text !== saved.current) {
        // Not sent: keep it as the thread's draft, so it outlives the card.
        saved.current = text;
        unsaved.delete(key);
        actions.saveReplyDraft(item.id, text);
      }
    } finally { settling.current = false; }
  }
  async function discard() {
    settling.current = true;
    try {
      unsaved.delete(key);
      if (saved.current || item.replyDraft) await actions.discardReplyDraft(item.id);
      saved.current = "";
      setText("");
      close();
    } finally { settling.current = false; }
  }
  function cancel() {
    // Esc leaves what you wrote as the draft; an empty box just closes.
    if (!text.trim()) { unsaved.delete(key); close(); return; }
    box.current?.blur();
    setEditing(false);
  }

  if (!editing && !draft && !unsaved.has(key)) return null;
  // The agent's words until you change them.
  const agent = item.replyDraft?.author === "agent" && text === draft;
  const label = REPLY_DRAFT_LABEL[agent ? "agent" : "reviewer"];
  const action = cn("h-7 px-2 text-xs", TOUCH_CONTROL);
  return (
    <div ref={card} role="group" aria-label={`${label} on ${where}`} data-keyboard-box className={cn("space-y-2 rounded-md bg-background/60 px-2.5 py-2", notSubmitted(agent ? "agent" : "yours"))}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon name={agent ? "Sparkles" : "CircleDashed"} className={cn("size-3.5 shrink-0", agent ? "text-(--ansi-13)" : "text-primary")} aria-hidden />{label}
      </p>
      {editing
        ? <Textarea ref={box} aria-label={`Reply on ${where}`} value={text} disabled={busy} placeholder="Reply on GitHub…" className="min-h-16 bg-background text-sm"
            onChange={(event) => change(event.target.value)} onBlur={save}
            onKeyDown={(event) => composerKeys(event, text.trim() && !busy ? () => void send() : null, cancel)} />
        : <CommentBody body={agent ? linkImages(text) : text} />}
      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" data-reply-action="send" className={action} disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? <Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Icon name="Github" className="size-3.5" aria-hidden />}Send reply
        </Button>
        {!editing && <Button variant="ghost" size="sm" className={action} disabled={busy} onClick={() => { focusBox.current = true; setEditing(true); }}>Edit</Button>}
        <Button variant="ghost" size="sm" data-reply-action="discard" className={cn(action, "hover:text-destructive-text")} disabled={busy} onClick={() => void discard()}>Discard</Button>
        <span className="ml-auto text-[11px] text-subtle-foreground">Posts now, not with your review</span>
      </div>
    </div>
  );
}
