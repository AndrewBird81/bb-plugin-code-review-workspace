// How long each of a review's chapters showed in a window in view, kept on the server (chapter_reads) so every device
// counts it, and when you said a chapter's quick read was fine: lib/approve-guard.ts reads both.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import type { ChapterRead } from "../src/store";

/** While a chapter shows, the time counted here is saved about this often, and again as it stops showing. */
export const CHAPTER_SAVE_MS = 60_000;
/** Less than this isn't worth a write: a chapter passed through. */
const MIN_SAVE_MS = 1_000;
/** The most the server adds at once. */
const MAX_SAVE_MS = 3_600_000;

/** One review's: what the server last said, what's counted here and not saved yet, and the stretch showing now. */
interface Session {
  targetKey: string;
  saved: Map<string, number>;
  unsaved: Map<string, number>;
  fine: Map<string, number>;
  stretch: { chapterId: string; since: number } | null;
  saving: boolean;
}

export interface ChapterReads {
  /** Each chapter's time in view, as of the last minute or so. */
  opened: ReadonlyMap<string, number>;
  /** When you said each chapter's quick read was fine, by the server's clock, which marks files viewed. */
  fine: ReadonlyMap<string, number>;
  /** Each chapter's time in view now, the stretch showing included. */
  openedNow(): Map<string, number>;
  /** What the server read with the review's views (getFileViews). */
  received(chapters: readonly ChapterRead[] | undefined): void;
  /** It's fine: the chapter's quick read, as it's marked now. False when it couldn't be saved. */
  markFine(chapterId: string): Promise<boolean>;
}

const add = (map: Map<string, number>, key: string, ms: number) => map.set(key, (map.get(key) ?? 0) + ms);
const same = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) => a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);

/** Counts the time `chapterId` shows while the page is visible, for the review `targetKey`. */
export function useChapterReads(targetKey: string, chapterId: string | null): ChapterReads {
  const rpc = useRpc<typeof rpcContract>();
  const session = useMemo<Session>(() => ({ targetKey, saved: new Map(), unsaved: new Map(), fine: new Map(), stretch: null, saving: false }), [targetKey]);
  const current = useRef(session);
  current.current = session;
  const [shown, setShown] = useState<{ session: Session; opened: ReadonlyMap<string, number>; fine: ReadonlyMap<string, number> }>({ session, opened: new Map(), fine: new Map() });
  // What was last shown, or is about to be: a read that changes nothing draws nothing.
  const last = useRef(shown);

  const totals = useCallback((stretch: boolean) => {
    const sum = new Map(session.saved);
    for (const [id, ms] of session.unsaved) add(sum, id, ms);
    if (stretch && session.stretch) add(sum, session.stretch.chapterId, Date.now() - session.stretch.since);
    return sum;
  }, [session]);
  const publish = useCallback(() => {
    if (current.current !== session) return;
    const next = { session, opened: totals(false), fine: new Map(session.fine) };
    if (last.current.session === session && same(last.current.opened, next.opened) && same(last.current.fine, next.fine)) return;
    last.current = next;
    setShown(next);
  }, [session, totals]);
  // The stretch so far goes into what's unsaved, and goes on from now. A gap of more than two saves is a machine that
  // slept with the page showing, which counts as two.
  const roll = useCallback(() => {
    const stretch = session.stretch;
    if (!stretch) return;
    const at = Date.now();
    add(session.unsaved, stretch.chapterId, Math.min(Math.max(0, at - stretch.since), 2 * CHAPTER_SAVE_MS));
    stretch.since = at;
  }, [session]);
  // One save at a time, a chapter at a time; what doesn't save waits for the next.
  const save = useCallback(async () => {
    if (session.saving) return;
    session.saving = true;
    try {
      for (const [id, ms] of [...session.unsaved]) {
        const sent = Math.min(Math.round(ms), MAX_SAVE_MS);
        if (sent < MIN_SAVE_MS) continue;
        const result = await rpc.call("addChapterOpenTime", { targetKey: session.targetKey, chapterId: id, ms: sent }).catch(() => null);
        if (!result) continue;
        add(session.unsaved, id, -sent);
        if (session.unsaved.get(id)! <= 0) session.unsaved.delete(id);
        if (result.openMs !== undefined) session.saved.set(id, Math.max(session.saved.get(id) ?? 0, result.openMs));
      }
    } finally {
      session.saving = false;
    }
    publish();
  }, [rpc, session, publish]);

  useEffect(() => {
    const start = () => {
      if (chapterId && document.visibilityState === "visible" && !session.stretch) session.stretch = { chapterId, since: Date.now() };
    };
    const stop = () => {
      roll();
      session.stretch = null;
      publish();
      void save();
    };
    start();
    const onVisibility = () => { if (document.visibilityState === "visible") start(); else stop(); };
    document.addEventListener("visibilitychange", onVisibility);
    const tick = setInterval(() => {
      if (!session.stretch) return;
      roll();
      publish();
      void save();
    }, CHAPTER_SAVE_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(tick);
      stop();
    };
  }, [session, chapterId, roll, publish, save]);

  const received = useCallback((chapters: readonly ChapterRead[] | undefined) => {
    for (const { chapterId: id, openMs, fineAt } of chapters ?? []) {
      session.saved.set(id, Math.max(session.saved.get(id) ?? 0, openMs));
      if (fineAt !== null && fineAt > (session.fine.get(id) ?? -1)) session.fine.set(id, fineAt);
    }
    publish();
  }, [session, publish]);

  const markFine = useCallback(async (id: string) => {
    const before = session.fine.get(id);
    // Fine at once; the server's time once it says.
    session.fine.set(id, Number.MAX_SAFE_INTEGER);
    publish();
    const result = await rpc.call("setChapterFine", { targetKey: session.targetKey, chapterId: id }).catch(() => null);
    if (result?.ok && result.fineAt !== undefined) session.fine.set(id, result.fineAt);
    else if (before === undefined) session.fine.delete(id);
    else session.fine.set(id, before);
    publish();
    return !!result?.ok;
  }, [rpc, session, publish]);

  const openedNow = useCallback(() => totals(true), [totals]);
  const fresh = shown.session === session;
  return useMemo(() => ({
    opened: fresh ? shown.opened : new Map(),
    fine: fresh ? shown.fine : new Map(),
    openedNow,
    received,
    markFine,
  }), [fresh, shown, openedNow, received, markFine]);
}
