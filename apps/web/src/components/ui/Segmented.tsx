import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

/** A row of mutually exclusive buttons: the panel tabs, a tunnel mode. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  className?: string;
}) {
  return (
    <div
      className={cn("inline-flex rounded-md border border-edge bg-deep p-0.5", className)}
      role="tablist"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          title={o.title}
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex h-5.5 items-center gap-1 rounded-[5px] px-2 text-xs font-medium text-dim transition-colors hover:text-text [&_svg]:size-3.5",
            o.value === value && "bg-surface text-text shadow-sm",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
