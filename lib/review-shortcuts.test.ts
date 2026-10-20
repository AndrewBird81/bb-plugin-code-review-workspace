import { afterEach, expect, test } from "vitest";
import { shortcutKey } from "./review-shortcuts";

afterEach(() => { document.body.innerHTML = ""; });

const kd = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

/** The shortcut a key pressed on `el` asks for, as the workspace's document listener reads it. */
function pressOn(el: HTMLElement, init: KeyboardEventInit): string | null {
  let top = el;
  while (top.parentElement) top = top.parentElement;
  document.body.append(top);
  let got: string | null = null;
  document.addEventListener("keydown", (event) => { got = shortcutKey(event); }, { once: true });
  el.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, composed: true }));
  return got;
}

test("a plain key asks for its shortcut, and a key that isn't one asks for none", () => {
  expect(shortcutKey(kd({ key: "j" }))).toBe("j");
  expect(shortcutKey(kd({ key: "x" }))).toBe("x");
  expect(shortcutKey(kd({ key: "z" }))).toBeNull();
});

test("Caps Lock j still moves, and Caps Lock v marks the file: only Shift makes ⇧V, ⇧F, ⇧J and ⇧K", () => {
  expect(shortcutKey(kd({ key: "J" }))).toBe("j");
  expect(shortcutKey(kd({ key: "V" }))).toBe("v");
  expect(shortcutKey(kd({ key: "F" }))).toBe("f");
  expect(shortcutKey(kd({ key: "V", shiftKey: true }))).toBe("V");
  expect(shortcutKey(kd({ key: "F", shiftKey: true }))).toBe("F");
  // Shift j types J: the next change, and Shift k the one before.
  expect(shortcutKey(kd({ key: "J", shiftKey: true }))).toBe("J");
  expect(shortcutKey(kd({ key: "K", shiftKey: true }))).toBe("K");
});

test("AltGr ] (ctrl+alt) and Option-] (alt) step comments, on layouts that type brackets that way", () => {
  expect(shortcutKey(kd({ key: "]", ctrlKey: true, altKey: true }))).toBe("]");
  expect(shortcutKey(kd({ key: "[", altKey: true }))).toBe("[");
  expect(shortcutKey(kd({ key: "]", altKey: true }))).toBe("]");
});

test("Alt, Ctrl or Meta with any other key, or Ctrl or Meta with a bracket, is no shortcut", () => {
  expect(shortcutKey(kd({ key: "j", altKey: true }))).toBeNull();
  expect(shortcutKey(kd({ key: "j", ctrlKey: true, altKey: true }))).toBeNull();
  expect(shortcutKey(kd({ key: "]", ctrlKey: true }))).toBeNull();
  expect(shortcutKey(kd({ key: "]", metaKey: true }))).toBeNull();
  expect(shortcutKey(kd({ key: "]", metaKey: true, altKey: true }))).toBeNull();
});

test("a held key repeats only j and k, and ⇧J and ⇧K", () => {
  expect(shortcutKey(kd({ key: "v", repeat: true }))).toBeNull();
  expect(shortcutKey(kd({ key: "c", repeat: true }))).toBeNull();
  expect(shortcutKey(kd({ key: "]", repeat: true }))).toBeNull();
  expect(shortcutKey(kd({ key: "j", repeat: true }))).toBe("j");
  expect(shortcutKey(kd({ key: "k", repeat: true }))).toBe("k");
  expect(shortcutKey(kd({ key: "J", shiftKey: true, repeat: true }))).toBe("J");
  expect(shortcutKey(kd({ key: "K", shiftKey: true, repeat: true }))).toBe("K");
});

test("c inside an overlay side still toggles; inside another dialog, it's the dialog's", () => {
  const side = document.createElement("div");
  side.setAttribute("role", "dialog");
  side.setAttribute("data-gr-side", "");
  const inSide = document.createElement("button");
  side.append(inSide);
  expect(pressOn(inSide, { key: "c" })).toBe("c");

  for (const role of ["dialog", "alertdialog"]) {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", role);
    const button = document.createElement("button");
    dialog.append(button);
    expect(pressOn(button, { key: "c" })).toBeNull();
  }
});

test("a box typed in, even inside an overlay side, takes its keys", () => {
  const side = document.createElement("div");
  side.setAttribute("role", "dialog");
  side.setAttribute("data-gr-side", "");
  const input = document.createElement("input");
  side.append(input);
  expect(pressOn(input, { key: "c" })).toBeNull();
});
