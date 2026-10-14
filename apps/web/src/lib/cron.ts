/**
 * Friendly schedules, and the cron expressions behind them. The UI offers
 * the handful of shapes people actually want (every N minutes, hourly, daily,
 * on certain weekdays, monthly) and only falls back to raw cron for the rest.
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Repeat =
  | { kind: "minutes"; every: number }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; days: Weekday[]; time: string }
  | { kind: "monthly"; day: number; time: string }
  | { kind: "custom"; cron: string };

export const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const longWeekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Every N minutes divides an hour evenly, so runs stay on a steady rhythm. */
export const minuteSteps = [5, 10, 15, 20, 30] as const;

function hm(time: string): [number, number] {
  const [h, m] = time.split(":").map(Number);
  return [h ?? 0, m ?? 0];
}

export function toCron(r: Repeat): string {
  switch (r.kind) {
    case "minutes":
      return `*/${r.every} * * * *`;
    case "hourly":
      return `${r.minute} * * * *`;
    case "daily": {
      const [h, m] = hm(r.time);
      return `${m} ${h} * * *`;
    }
    case "weekdays": {
      const [h, m] = hm(r.time);
      const days = [...new Set(r.days)].sort((a, b) => a - b);
      return `${m} ${h} * * ${days.length ? days.join(",") : "*"}`;
    }
    case "monthly": {
      const [h, m] = hm(r.time);
      return `${m} ${h} ${r.day} * *`;
    }
    case "custom":
      return r.cron.trim();
  }
}

const num = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);
const pad = (n: number) => String(n).padStart(2, "0");

/** Reads a cron expression back into a friendly shape, or `custom` if it's anything else. */
export function fromCron(cron: string): Repeat {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { kind: "custom", cron };
  const [min, hour, dom, mon, dow] = parts;
  const step = /^\*\/(\d+)$/.exec(min ?? "");
  if (step && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { kind: "minutes", every: Number(step[1]) };
  }
  const m = num(min);
  const h = num(hour);
  if (m === null || mon !== "*") return { kind: "custom", cron };
  if (hour === "*" && dom === "*" && dow === "*") return { kind: "hourly", minute: m };
  if (h === null) return { kind: "custom", cron };
  const time = `${pad(h)}:${pad(m)}`;
  if (dom === "*" && dow === "*") return { kind: "daily", time };
  if (dom === "*" && dow && /^[0-7](,[0-7])*$/.test(dow)) {
    const days = [...new Set(dow.split(",").map((d) => weekday(Number(d))))];
    return { kind: "weekdays", days, time };
  }
  if (dom === "*" && dow && /^[0-6]-[0-6]$/.test(dow)) {
    const [a, b] = dow.split("-").map(Number);
    const days: Weekday[] = [];
    for (let d = a ?? 0; d <= (b ?? 0); d++) days.push(weekday(d));
    return { kind: "weekdays", days, time };
  }
  const d = num(dom);
  if (d !== null && dow === "*") return { kind: "monthly", day: d, time };
  return { kind: "custom", cron };
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
}

const weekdays: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];
/** 0 to 7 (7 is Sunday again, as cron allows) to a weekday. */
function weekday(n: number): Weekday {
  return weekdays[n % 7] ?? 0;
}

function dayList(days: Weekday[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const key = sorted.join(",");
  if (key === "1,2,3,4,5") return "weekdays";
  if (key === "0,6") return "weekends";
  if (sorted.length === 7) return "every day";
  const names = sorted.map((d) => longWeekdayNames[d]);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "Every day at 09:00", "Weekdays at 08:30", or the raw expression when it's unusual. */
export function describeCron(cron: string): string {
  const r = fromCron(cron);
  switch (r.kind) {
    case "minutes":
      return r.every === 1 ? "Every minute" : `Every ${r.every} minutes`;
    case "hourly":
      return r.minute === 0 ? "Every hour, on the hour" : `Every hour at :${pad(r.minute)}`;
    case "daily":
      return `Every day at ${r.time}`;
    case "weekdays": {
      const list = dayList(r.days);
      return list === "every day"
        ? `Every day at ${r.time}`
        : `${list.charAt(0).toUpperCase()}${list.slice(1)} at ${r.time}`;
    }
    case "monthly":
      return `The ${ordinal(r.day)} of every month at ${r.time}`;
    case "custom":
      return `Custom: ${r.cron}`;
  }
}
