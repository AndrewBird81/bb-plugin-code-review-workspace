import type { KeyboardEvent } from "react";

/**
 * The key confirms or cancels an IME conversion, and should do nothing else. Safari has already cleared isComposing
 * on the key that ends one, but still reports keyCode 229.
 */
export function composing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}
