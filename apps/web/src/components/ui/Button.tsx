import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

const variants = {
  primary: "bg-accent text-accent-text hover:bg-accent-hover border-transparent",
  secondary: "bg-surface text-text border-edge hover:bg-hover",
  ghost: "bg-transparent text-dim border-transparent hover:bg-hover hover:text-text",
  danger:
    "bg-surface text-danger border-edge hover:bg-danger hover:text-white hover:border-transparent",
};

const sizes = {
  sm: "h-6 px-2 text-xs gap-1 rounded-md",
  md: "h-7 px-2.5 text-sm gap-1.5 rounded-md",
  icon: "h-6 w-6 justify-center rounded-md",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center border font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
