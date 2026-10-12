import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "../../lib/utils";
import { useFullscreenPortalContainer, usePortalScopeProps } from "../../lib/portal-scope";
import { FOLD_HALF } from "../../lib/use-fold";
import { phoneWindow } from "../../lib/workspace-layout";
import {
  type ResponsiveOverlayContextValue,
  useResponsiveRoot,
  MobileTrigger,
  ResponsiveDrawerShell,
  stripRadixContentProps,
} from "./responsive-overlay.js";
import {
  blurActiveKeyboardInputBeforeOverlayOpen,
  getOverlayTriggerClassName,
  preventOverlayTriggerSelection,
} from "./overlay-trigger.js";

// ---------------------------------------------------------------------------
// Context — separate instance from DropdownMenu
// ---------------------------------------------------------------------------

const ResponsivePopoverContext =
  React.createContext<ResponsiveOverlayContextValue>({
    isCompactViewport: false,
    open: false,
    onOpenChange: () => {},
  });

function useResponsivePopover() {
  return React.useContext(ResponsivePopoverContext);
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function Popover({
  children,
  open: controlledOpen,
  onOpenChange: controlledOnChange,
  defaultOpen,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const ctx = useResponsiveRoot(
    controlledOpen,
    controlledOnChange,
    defaultOpen,
  );

  if (ctx.isCompactViewport) {
    return (
      <ResponsivePopoverContext.Provider value={ctx}>
        {children}
      </ResponsivePopoverContext.Provider>
    );
  }

  return (
    <PopoverPrimitive.Root
      open={ctx.open}
      onOpenChange={ctx.onOpenChange}
      {...props}
    >
      <ResponsivePopoverContext.Provider value={ctx}>
        {children}
      </ResponsivePopoverContext.Provider>
    </PopoverPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

const PopoverTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>(({ asChild, children, className, ...props }, ref) => {
  const { isCompactViewport, open, onOpenChange } = useResponsivePopover();

  if (isCompactViewport) {
    return (
      <MobileTrigger
        ref={ref}
        asChild={asChild}
        open={open}
        onOpenChange={onOpenChange}
        haspopup="dialog"
        className={className}
        {...props}
      >
        {children}
      </MobileTrigger>
    );
  }

  return (
    <PopoverPrimitive.Trigger
      ref={ref}
      asChild={asChild}
      className={getOverlayTriggerClassName(className)}
      onMouseDown={(event) => {
        if (!open) {
          blurActiveKeyboardInputBeforeOverlayOpen();
        }
        preventOverlayTriggerSelection(event);
      }}
      {...props}
    >
      {children}
    </PopoverPrimitive.Trigger>
  );
});
PopoverTrigger.displayName = "PopoverTrigger";

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** The band of the window a popover keeps out of: it ends above `top` or starts below `bottom`. */
export type FoldBand = { top: number; bottom: number };

/**
 * The fold running across an iPhone Duo's inner screen held upright, as a band menus keep out of (lanes/00-devices.md,
 * requirement 6): 8px either side of it where the browser reports it (the Viewport Segments API); else, on a touch
 * screen whose window is a phone's held upright, where it's estimated to be. In a home-screen app, whose window is the
 * screen, that's the window's middle, FOLD_HALF either side; in Safari, 40% to 52% of the window, either side of where
 * Safari's toolbars put it (page y 373–414 of 869). Null elsewhere.
 */
export function foldBand(): FoldBand | null {
  const segments = (window as { viewport?: { segments?: ReadonlyArray<DOMRectReadOnly> | null } }).viewport?.segments;
  const [upper, lower, ...more] = segments ?? [];
  if (upper && lower && !more.length && lower.top >= upper.bottom) return { top: upper.bottom - 8, bottom: lower.top + 8 };
  const size = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
  const matches = (query: string) => !!window.matchMedia?.(query).matches;
  if (!matches("(pointer: coarse)") || !phoneWindow(size) || size.height <= size.width) return null;
  if (matches("(display-mode: standalone)")) return { top: Math.round(size.height / 2 - FOLD_HALF), bottom: Math.round(size.height / 2 + FOLD_HALF) };
  return { top: Math.round(size.height * 0.4), bottom: Math.round(size.height * 0.52) };
}

/**
 * The edge a popover from `trigger` collides with, as Radix's collision padding, in a window `height` tall: from a
 * trigger nearer the top it keeps above `band`, else below it.
 */
export function foldPadding(trigger: { top: number; bottom: number }, band: FoldBand, height: number): { top: number } | { bottom: number } {
  return trigger.top + trigger.bottom < band.top + band.bottom ? { bottom: Math.ceil(height - band.top) } : { top: Math.ceil(band.bottom) };
}

/**
 * Where an open popover keeps, out of the fold's band (`foldBand()`), as its collision padding; null without one. It
 * opens on the side of its trigger with more of it in that part of the window, and scrolls what doesn't fit, its cut
 * falling mid-row, so it reads as more to scroll to.
 */
function useFoldPadding(content: HTMLElement | null, open: boolean): { top: number } | { bottom: number } | null {
  const [padding, setPadding] = React.useState<{ top: number } | { bottom: number } | null>(null);
  React.useLayoutEffect(() => {
    if (!open || !content) return;
    const measure = () => {
      const trigger = content.id ? Array.from(document.querySelectorAll("[aria-controls]")).find((el) => el.getAttribute("aria-controls") === content.id) : null;
      const band = foldBand();
      setPadding(band && trigger ? foldPadding(trigger.getBoundingClientRect(), band, document.documentElement.clientHeight) : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [content, open]);
  return open ? padding : null;
}

type Sides = { top: number; right: number; bottom: number; left: number };
const NO_SIDES: Sides = { top: 0, right: 0, bottom: 0, left: 0 };

/** The window's safe areas (env(safe-area-inset-*)): the status bar, a notch, the home indicator, in a home-screen app. */
function safeAreaInsets(): Sides {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const insets = { top: parseFloat(style.paddingTop) || 0, right: parseFloat(style.paddingRight) || 0, bottom: parseFloat(style.paddingBottom) || 0, left: parseFloat(style.paddingLeft) || 0 };
  probe.remove();
  return insets;
}

/** An open popover's safe areas, which Radix's collision padding doesn't know; measured again as the window resizes. */
function useSafeAreaInsets(open: boolean): Sides {
  const [insets, setInsets] = React.useState(NO_SIDES);
  React.useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setInsets((current) => {
      const next = safeAreaInsets();
      return (Object.keys(next) as Array<keyof Sides>).every((side) => next[side] === current[side]) ? current : next;
    });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);
  return insets;
}

/** Collision padding that keeps each of the paddings asked for: the caller's, the fold's and the safe areas'. */
function collisionSides(...paddings: Array<number | Partial<Sides> | null | undefined>): Sides {
  const sides = { ...NO_SIDES };
  for (const padding of paddings) {
    for (const side of Object.keys(sides) as Array<keyof Sides>) {
      const value = typeof padding === "number" ? padding : padding?.[side] ?? 0;
      sides[side] = Math.max(sides[side], value);
    }
  }
  return sides;
}

const PopoverContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    /** Title announced by screen readers when the mobile drawer opens. */
    mobileTitle?: string;
    /** Class name applied to the drawer panel on mobile. */
    mobileClassName?: string;
    /** Called when the mobile drawer transform completes. */
    onMobileContentAnimationEnd?: (open: boolean) => void;
  }
>(
  (
    {
      className,
      align = "center",
      sideOffset = 4,
      children,
      mobileTitle,
      mobileClassName,
      onMobileContentAnimationEnd,
      style,
      ...props
    },
    ref,
  ) => {
    const { isCompactViewport, open, onOpenChange } = useResponsivePopover();
    // Unconditional (rules of hooks — the compact branch returns early); the
    // compact drawer path is covered by the persistent drawer shell.
    const scopeProps = usePortalScopeProps();
    const portalContainer = useFullscreenPortalContainer();
    const [content, setContent] = React.useState<HTMLDivElement | null>(null);
    const fold = useFoldPadding(isCompactViewport ? null : content, open);
    const insets = useSafeAreaInsets(!isCompactViewport && open);
    // Inside the window's safe areas, out of the fold's band; what doesn't fit scrolls.
    const kept = fold || insets.top || insets.right || insets.bottom || insets.left ? collisionSides(props.collisionPadding, fold, insets) : null;
    const contentRef = React.useCallback((el: HTMLDivElement | null) => {
      setContent(el);
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    }, [ref]);

    if (isCompactViewport) {
      // Forward DOM-level props (event handlers, data-*, aria-*) but strip
      // Radix positioning/behavior props that are meaningless for a Drawer.
      const domProps = stripRadixContentProps(props);

      return (
        <ResponsiveDrawerShell
          open={open}
          onOpenChange={onOpenChange}
          srLabel={mobileTitle ?? "Options"}
          contentClassName={mobileClassName}
          onContentAnimationEnd={onMobileContentAnimationEnd}
        >
          <div
            ref={ref}
            className={cn(
              "overflow-y-auto px-4 pt-2",
              className,
              // The drawer spans the full viewport width; ignore a desktop
              // width a caller passes so content fills the drawer.
              "w-auto max-w-none",
              // Its end stays clear of the home indicator, whatever padding a
              // caller passes for the popover (a menu's p-1).
              "pb-[max(1rem,env(safe-area-inset-bottom))]",
            )}
            style={style}
            {...domProps}
          >
            {children}
          </div>
        </ResponsiveDrawerShell>
      );
    }

    return (
      <PopoverPrimitive.Portal container={portalContainer}>
        <PopoverPrimitive.Content
          ref={contentRef}
          {...scopeProps}
          align={align}
          sideOffset={sideOffset}
          className={cn(
            "z-50 w-96 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            className,
          )}
          {...props}
          collisionPadding={kept ?? props.collisionPadding}
          style={kept ? { ...style, maxHeight: "var(--radix-popover-content-available-height)", overflowY: "auto" } : style}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    );
  },
);
PopoverContent.displayName = "PopoverContent";

// ---------------------------------------------------------------------------
// Anchor (desktop-only positioning concept — passthrough on mobile)
// ---------------------------------------------------------------------------

const PopoverAnchor = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Anchor>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Anchor>
>(({ children, ...props }, ref) => {
  const { isCompactViewport } = useResponsivePopover();

  if (isCompactViewport) {
    return <>{children}</>;
  }

  return (
    <PopoverPrimitive.Anchor ref={ref} {...props}>
      {children}
    </PopoverPrimitive.Anchor>
  );
});
PopoverAnchor.displayName = "PopoverAnchor";

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
