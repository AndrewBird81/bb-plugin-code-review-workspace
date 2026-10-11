// Touch sizes for the plugin's own controls, kept out of components/ui (BB's kit): every control is a 44px target on
// a coarse pointer, an iPad's included, so these use pointer-coarse alone, without the kit's max-md guard.

/** A control 44px tall on a coarse pointer, and at least as wide. */
export const TOUCH_CONTROL = "pointer-coarse:h-11 pointer-coarse:min-w-11";

/** In BB's 48px title bar a button stays 36px on a coarse pointer, with a 44px target around it. */
export const TOUCH_TITLE_BAR = "relative pointer-coarse:h-9 pointer-coarse:min-w-9 pointer-coarse:after:absolute pointer-coarse:after:-inset-1 pointer-coarse:after:content-['']";

/** A resize handle's target around its 1px line, in its ::before: 9px wide, and 12px on a coarse pointer. */
export const TOUCH_HANDLE = "before:-inset-x-1 pointer-coarse:before:-inset-x-[5.5px]";
