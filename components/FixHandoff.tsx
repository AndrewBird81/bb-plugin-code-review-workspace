import { useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import { linesOf, type DraftComment } from "../src/draft";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { locationKey } from "./InlineDraft";

/** Fix in a new thread: hands the draft comments you choose on your own change to a visible BB thread. */
export function FixHandoff({ targetKey, comments }: { targetKey: string; comments: readonly DraftComment[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [choosing, setChoosing] = useState(false);
  // The comments you left out; ones added meanwhile are in.
  const [left, setLeft] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ threadId: string; title: string } | null>(null);
  const chosen = comments.filter((comment) => !left.includes(locationKey(comment)));
  if (!comments.length && !started) return null;
  async function start() {
    setBusy(true); setError(null);
    try {
      setStarted(await rpc.call("startFixThread", { targetKey, comments: chosen.map(({ file, line, side }) => ({ file, line, side })) }));
      setChoosing(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn’t start the thread. Try again.");
    } finally { setBusy(false); }
  }
  return <section aria-label="Fix in a new thread" className="space-y-2 border-t border-border pt-3">
    {started && <p role="status" className="text-xs text-muted-foreground">Started a thread: <span className="text-foreground">{started.title}</span> · <button type="button" className="rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={() => navigate.toThread(started.threadId)}>Open</button></p>}
    {error && <p role="alert" className="text-xs text-destructive-text">{error}</p>}
    {choosing ? <fieldset className="space-y-2">
      <legend className="mb-2 text-xs font-medium">Comments to fix</legend>
      {comments.map((comment) => {
        const key = locationKey(comment);
        return <label key={key} className="flex items-start gap-2.5 text-xs">
          <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" disabled={busy} checked={!left.includes(key)} onChange={(event) => setLeft(event.target.checked ? left.filter((k) => k !== key) : [...left, key])} />
          <span className="min-w-0"><span className="font-mono text-[11px]">{comment.file}:{linesOf(comment)}</span> <span className="line-clamp-1 break-words text-muted-foreground">{comment.body}</span></span>
        </label>;
      })}
      <p className="text-xs text-muted-foreground">Starts a BB thread in this project to fix them. Your draft stays as it is.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !chosen.length} onClick={() => void start()}>{busy && <Icon name="Loading" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}Start thread</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChoosing(false)}>Cancel</Button>
      </div>
    </fieldset> : comments.length > 0 && <Button variant="outline" size="sm" onClick={() => { setChoosing(true); setLeft([]); setError(null); }}><Icon name="Code" className="size-4" aria-hidden />Fix in a new thread</Button>}
  </section>;
}
