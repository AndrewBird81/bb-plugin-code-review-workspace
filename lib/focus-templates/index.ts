import type { Focus } from "../review-preferences";
import { docs } from "./docs";

export const focusTemplates = [docs];

/** Absent instructions follow the shipped template; even empty saved text is the reviewer's. */
export function focusInstructions(focus: Pick<Focus, "template" | "instructions">): string {
  return focus.instructions ?? focusTemplates.find((template) => template.id === focus.template)?.instructions ?? "";
}
