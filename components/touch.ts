// Touch sizes for the plugin's own controls, kept out of components/ui (BB's kit): every control is a 44px target on
// a coarse pointer, an iPad's included, so these use pointer-coarse alone, without the kit's max-md guard.

/** A control 44px tall on a coarse pointer, and at least as wide. */
export const TOUCH_CONTROL = "pointer-coarse:h-11 pointer-coarse:min-w-11";

/**
 * A button that keeps to 36px on a coarse pointer, with a 44px target around it: in BB's 48px title bar, and in the
 * 40px band of a phone held sideways.
 */
export const TOUCH_COMPACT = "relative pointer-coarse:h-9 pointer-coarse:min-w-9 pointer-coarse:after:absolute pointer-coarse:after:-inset-1 pointer-coarse:after:content-['']";

/** A resize handle's target around its 1px line, in its ::before: 9px wide, and 12px on a coarse pointer. */
export const TOUCH_HANDLE = "before:-inset-x-1 pointer-coarse:before:-inset-x-[5.5px]";

/**
 * A text link, or a small control such as a dialog's ✕, that keeps its size: a target 44px tall and at least as wide,
 * centred on it, in its ::after, on a coarse pointer. The element must be positioned (relative or absolute).
 */
export const TOUCH_TARGET = "pointer-coarse:after:absolute pointer-coarse:after:left-1/2 pointer-coarse:after:top-1/2 pointer-coarse:after:h-11 pointer-coarse:after:w-full pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2 pointer-coarse:after:content-['']";
