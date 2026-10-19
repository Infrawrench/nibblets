import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

const fieldClass =
  "w-full rounded-md border border-edge bg-field px-2 text-sm text-text placeholder:text-faint focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldClass, "h-7", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(fieldClass, "min-h-16 resize-y py-1.5 leading-snug", className)}
      {...props}
    />
  );
}

export function Select({
  className,
  options,
  value,
  onChange,
  disabled,
}: {
  className?: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      className={cn(fieldClass, "h-7 pr-6", className)}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A labelled row: dim label in a fixed column, the control beside it. */
export function FieldRow({
  label,
  hint,
  children,
  top,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  top?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex gap-3 max-sm:flex-col max-sm:items-stretch max-sm:gap-1",
        top ? "items-start" : "min-h-7 items-center",
      )}
    >
      <span
        className={cn("w-28 shrink-0 text-sm text-dim max-sm:w-auto max-sm:pt-0", top && "pt-1.5")}
      >
        {label}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        {children}
        {hint ? <span className="text-xs text-faint">{hint}</span> : null}
      </span>
    </label>
  );
}

export function SectionHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between pt-2">
      <h3 className="text-2xs font-semibold tracking-wider text-faint uppercase">{children}</h3>
      {action}
    </div>
  );
}
