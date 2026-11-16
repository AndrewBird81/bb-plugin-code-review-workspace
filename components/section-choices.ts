import { useEffect, useState } from "react";
import { experimental_useSidebarThreads, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import { reviewState, type ReviewItem } from "../lib/review-state";

export const LIST = '[data-bb-plugin="thread-list"]';

/** The thread list's groups' keys, top to bottom. */
export const groupOrder = () => Array.from(document.querySelectorAll<HTMLElement>(`${LIST} [data-sidebar-visibility-group]`)).map((group) => group.dataset.sidebarVisibilityGroup ?? "");

/** Organized by project or machine, BB shows no sections. */
export const byProjectOrMachine = () => !!document.querySelector(`${LIST} [data-sidebar-visibility-group^="project:"], ${LIST} [data-sidebar-visibility-group^="machine:"]`);

/** Move to section ›'s choices, in the thread list's order: BB sections, by id, and its Threads group, "threads". */
export type SectionChoices = { id: string; label: string; selected: boolean }[];

// One read of Needs review's section for every menu, read again as BB's sections change.
let cached: { rpc: unknown; ids: string; id: Promise<string | null> } | null = null;

/**
 * Move to section ›'s choices for `review`, while `enabled` (Settings shows reviews in the thread list); undefined where BB
 * shows no sections, as organized by project or machine.
 */
export function useSectionChoices(review: ReviewItem, enabled: boolean): SectionChoices | undefined {
  const rpc = useRpc<typeof rpcContract>();
  const sidebar = experimental_useSidebarThreads();
  const ids = sidebar.sections.map((section) => section.id).join(",");
  const [needsId, setNeedsId] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (cached?.rpc !== rpc || cached.ids !== ids) cached = { rpc, ids, id: rpc.call("needsReviewSection", {}).then((result) => result.sectionId, () => null) };
    let live = true;
    void cached.id.then((id) => { if (live) setNeedsId(id); });
    return () => { live = false; };
  }, [rpc, enabled, ids]);
  if (!enabled || sidebar.status !== "ready" || byProjectOrMachine()) return undefined;
  const live = (id: string | null | undefined) => !!id && (id === "threads" || sidebar.sections.some((section) => section.id === id));
  const where = review.pinnedAt ? null : live(review.sectionId) ? review.sectionId : reviewState(review).group === "needs" && live(needsId) ? needsId : null;
  const order = groupOrder();
  // Where the list isn't drawn, the sections go in the order they were made.
  const place = (key: string) => { const at = order.indexOf(key); return at < 0 ? order.length : at; };
  return [...sidebar.sections.map((section) => ({ id: section.id, key: `section:${section.id}`, label: section.name })), { id: "threads", key: "threads", label: "Threads" }]
    .sort((a, b) => place(a.key) - place(b.key))
    .map(({ id, label }) => ({ id, label, selected: id === where }));
}
