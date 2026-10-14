import type { ReactNode } from "react";
import {
  describeCron,
  minuteSteps,
  toCron,
  weekdayNames,
  type Repeat,
  type Weekday,
} from "../../lib/cron.ts";
import { cn } from "../../lib/cn.ts";
import { Input, Select } from "../ui/Field.tsx";

type Kind = Repeat["kind"];

const kinds: { value: Kind; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "On certain days" },
  { value: "hourly", label: "Every hour" },
  { value: "minutes", label: "Every few minutes" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom (cron)" },
];

const isKind = (v: string): v is Kind => kinds.some((k) => k.value === v);

/** Switching shape keeps the time where there is one, so it doesn't jump back to 09:00. */
function switchKind(current: Repeat, kind: Kind): Repeat {
  const time = "time" in current ? current.time : "09:00";
  switch (kind) {
    case "minutes":
      return { kind, every: 15 };
    case "hourly":
      return { kind, minute: 0 };
    case "daily":
      return { kind, time };
    case "weekdays":
      return { kind, days: [1, 2, 3, 4, 5], time };
    case "monthly":
      return { kind, day: 1, time };
    case "custom":
      return { kind, cron: toCron(current) };
  }
}

const dayOrder: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

/**
 * Picks a repeating schedule the way people think about one ("weekdays at
 * 08:30") and turns it into cron underneath, with a plain-English check of
 * what it'll do.
 */
export function RepeatPicker({
  value,
  onChange,
  timezone,
}: {
  value: Repeat;
  onChange: (value: Repeat) => void;
  timezone: string;
}) {
  const time = (t: string, set: (time: string) => Repeat) => (
    <Input
      type="time"
      value={t}
      onChange={(e) => e.target.value && onChange(set(e.target.value))}
      className="w-28"
      required
    />
  );

  let detail: ReactNode = null;
  switch (value.kind) {
    case "minutes":
      detail = (
        <Select
          className="w-32"
          value={String(value.every)}
          onChange={(v) => onChange({ kind: "minutes", every: Number(v) })}
          options={minuteSteps.map((n) => ({ value: String(n), label: `every ${n} min` }))}
        />
      );
      break;
    case "hourly":
      detail = (
        <Select
          className="w-32"
          value={String(value.minute)}
          onChange={(v) => onChange({ kind: "hourly", minute: Number(v) })}
          options={Array.from({ length: 12 }, (_, i) => i * 5).map((m) => ({
            value: String(m),
            label: m === 0 ? "on the hour" : `at :${String(m).padStart(2, "0")}`,
          }))}
        />
      );
      break;
    case "daily":
      detail = <>at {time(value.time, (t) => ({ kind: "daily", time: t }))}</>;
      break;
    case "weekdays": {
      const days = value.days;
      const at = value.time;
      const toggle = (d: Weekday) =>
        onChange({
          kind: "weekdays",
          time: at,
          days: days.includes(d) ? days.filter((x) => x !== d) : [...days, d],
        });
      detail = (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1">
            {dayOrder.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={days.includes(d)}
                onClick={() => toggle(d)}
                className={cn(
                  "h-7 w-9 rounded-md border text-xs font-medium transition-colors",
                  days.includes(d)
                    ? "border-transparent bg-accent text-accent-text"
                    : "border-edge bg-field text-dim hover:text-text",
                )}
              >
                {weekdayNames[d]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-dim">
            at {time(at, (t) => ({ kind: "weekdays", days, time: t }))}
          </div>
        </div>
      );
      break;
    }
    case "monthly": {
      const at = value.time;
      detail = (
        <div className="flex items-center gap-1.5 text-xs text-dim">
          on the
          <Select
            className="w-20"
            value={String(value.day)}
            onChange={(v) => onChange({ kind: "monthly", day: Number(v), time: at })}
            options={Array.from({ length: 28 }, (_, i) => ({
              value: String(i + 1),
              label: String(i + 1),
            }))}
          />
          at {time(at, (t) => ({ kind: "monthly", day: value.day, time: t }))}
        </div>
      );
      break;
    }
    case "custom":
      detail = (
        <Input
          value={value.cron}
          onChange={(e) => onChange({ kind: "custom", cron: e.target.value })}
          className="font-mono"
          placeholder="0 9 * * 1-5"
          required
        />
      );
      break;
  }

  const cron = toCron(value);
  const problem =
    value.kind === "weekdays" && value.days.length === 0 ? "Pick at least one day" : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-dim">
        <Select
          className="w-40"
          value={value.kind}
          onChange={(k) => isKind(k) && onChange(switchKind(value, k))}
          options={kinds}
        />
        {value.kind === "weekdays" || value.kind === "custom" || value.kind === "monthly"
          ? null
          : detail}
      </div>
      {value.kind === "weekdays" || value.kind === "custom" || value.kind === "monthly"
        ? detail
        : null}
      <p className={cn("text-2xs", problem ? "text-danger" : "text-faint")}>
        {problem ??
          (value.kind === "custom"
            ? `${describeCron(cron).replace(/^Custom: /, "Cron: ")} · minute hour day month weekday, in ${timezone}`
            : `${describeCron(cron)}, ${timezone} time`)}
      </p>
    </div>
  );
}
