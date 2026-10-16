import { createElement } from "react";
import { cn } from "../../lib/utils";
import { ICON_DATA, type IconNode } from "./icon-data";

export type IconName = keyof typeof ICON_DATA;

export interface IconProps {
  name: IconName;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

/** An icon's SVG, drawn as Hugeicons' React component drew it: `size` square, and its own stroke width unless given one. */
function IconSvg({ nodes, size = 24, strokeWidth, ...props }: {
  nodes: readonly IconNode[];
  size?: number;
  strokeWidth?: number;
  className: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
  "data-icon": string;
}) {
  const stroke = strokeWidth === undefined ? {} : { strokeWidth, stroke: "currentColor" };
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" color="currentColor" {...stroke} {...props}>
      {nodes.map(([tag, attributes], index) => createElement(tag, { ...attributes, ...stroke, key: index }))}
    </svg>
  );
}

export function Icon({
  name,
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: IconProps) {
  return (
    <IconSvg
      nodes={ICON_DATA[name]}
      className={cn(className)}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      data-icon={name}
    />
  );
}
