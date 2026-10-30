// The thread a review's Sends go to (src/loop.ts), as its page shows it: Finish's Send and the Main thread tab ask the
// server for its title, whether it's archived or gone, and its machine; the cards' Send now needs only to know there's one.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import type { MainThreadLink } from "../src/loop";
import type { ReviewLifecycle } from "../src/store";
import { useKnob } from "./settings";

/** The id of the thread a review's Sends go to: its main thread, or for a review from before 1.8.0, the thread bb review ran in. */
export const recipientOf = (review: Pick<ReviewLifecycle, "mainThread" | "sourceThreadId"> | null | undefined): string | null =>
  review?.mainThread?.threadId ?? review?.sourceThreadId ?? null;

/**
 * The review's main thread while Send to thread is on and `active`: undefined until the server answers, null for none
 * (or the server couldn't say). It asks again when the main thread changes, and on `reload`, as after a Send.
 */
export function useMainThread(targetKey: string, review: Pick<ReviewLifecycle, "mainThread" | "sourceThreadId"> | null | undefined, active = true): { thread: MainThreadLink | null | undefined; reload(): void } {
  const rpc = useRpc<typeof rpcContract>();
  const sendOn = useKnob("sendToThread");
  const recipient = sendOn ? recipientOf(review) : null;
  const since = review?.mainThread?.since;
  const [asked, setAsked] = useState(0);
  const [thread, setThread] = useState<{ of: string; link: MainThreadLink | null } | null>(null);
  // Which thread it's for: a reload, or the same thread's newer record, keeps showing it until the answer comes.
  const of = `${targetKey}\0${recipient}`;
  useEffect(() => {
    if (!active || !recipient) return;
    let current = true;
    const answer = (link: MainThreadLink | null) => { if (current) setThread({ of, link }); };
    rpc.call("getSourceThread", { targetKey }).then(({ thread: link }) => answer(link), () => answer(null));
    return () => { current = false; };
  }, [rpc, targetKey, recipient, of, since, asked, active]);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  return { thread: !recipient ? null : thread?.of === of ? thread.link : undefined, reload };
}

// Change main thread, asked for from Finish review: the Main thread tab opens with its Change thread menu open, once.
const changeAsks = new Set<string>();
const changeListeners = new Set<() => void>();

/** Open the Main thread tab's Change thread menu, for the review's open page. */
export function askChangeThread(targetKey: string) {
  changeAsks.add(targetKey);
  for (const listener of changeListeners) listener();
}

/** Whether Change thread was asked for since the menu last took the ask; taking it, it's answered. */
export function useChangeThreadAsked(targetKey: string): () => boolean {
  const asked = useSyncExternalStore((listener) => {
    changeListeners.add(listener);
    return () => { changeListeners.delete(listener); };
  }, () => changeAsks.has(targetKey));
  return useCallback(() => asked && changeAsks.delete(targetKey), [asked, targetKey]);
}

/** The tab didn't open: what was asked of it goes, rather than open it unasked later. */
export function forgetMainThreadAsks(targetKey: string) {
  if (changeAsks.delete(targetKey)) for (const listener of changeListeners) listener();
}

/** Whether a review has Not pushed yet, its page after the chapters: a PR whose main thread works in a folder, a fixer's or its own. */
export const hasNotPushed = (review: Pick<ReviewLifecycle, "mainThread"> & { kind?: "pr" | "ref" }) => review.kind === "pr" && !!review.mainThread?.environmentId;
