import type { Focus } from "../review-preferences";
import { docs } from "./docs";
import { rules } from "./rules";
import { bugs } from "./bugs";
import { errors } from "./errors";
import { tests } from "./tests";
import { types } from "./types";
import { security } from "./security";

export const focusTemplates = [docs, rules, bugs, errors, tests, types, security];

/** Absent instructions follow the shipped template; even empty saved text is the reviewer's. */
export function focusInstructions(focus: Pick<Focus, "template" | "instructions">): string {
  return focus.instructions ?? focusTemplates.find((template) => template.id === focus.template)?.instructions ?? "";
}
