import { fireEvent, waitFor, within } from "@testing-library/react";
import type { renderSlot } from "@get-bb/plugin-sdk/testing/app";

type Slot = ReturnType<typeof renderSlot>;
type Name = string | RegExp;

/** Navigate the review's real ⋯ menu rather than assuming commands live in BB's header. */
export function openReviewMenu(slot: Slot) {
  const back = slot.queryByRole("button", { name: "Back to review actions" });
  if (back) fireEvent.click(back);
  if (!slot.queryByRole("button", { name: "Review settings…" })) {
    fireEvent.click(within(slot.getByRole("group", { name: "Review commands" })).getByRole("button", { name: "Review actions" }));
  }
}

export function reviewAction(slot: Slot, name: Name) {
  openReviewMenu(slot);
  return slot.getByRole("button", { name });
}

export function findReviewAction(slot: Slot, name: Name) {
  openReviewMenu(slot);
  return slot.findByRole("button", { name });
}

export function openDiffOptions(slot: Slot) {
  if (slot.queryByRole("switch", { name: "Wrap long lines" })) return;
  const back = slot.queryByRole("button", { name: "Back to Diff options" });
  if (back) { fireEvent.click(back); return; }
  openReviewMenu(slot);
  fireEvent.click(slot.getByRole("button", { name: "Diff options" }));
}

export function queryCompare(slot: Slot, name: Name = /^Show changes:/) {
  openDiffOptions(slot);
  return slot.queryByRole("button", { name });
}

export function getCompare(slot: Slot, name: Name = /^Show changes:/) {
  openDiffOptions(slot);
  return slot.getByRole("button", { name });
}

export function findCompare(slot: Slot, name: Name = /^Show changes:/) {
  return waitFor(() => getCompare(slot, name));
}
