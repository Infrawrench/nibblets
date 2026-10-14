import type { Snapshot, SnapshotPolicy } from "@nibblet/protocol";

/** The automatic snapshot choices offered, by minutes between them; null is off. */
export const snapshotFrequencies: { minutes: number | null; label: string }[] = [
  { minutes: null, label: "Off" },
  { minutes: 60, label: "Every hour" },
  { minutes: 6 * 60, label: "Every 6 hours" },
  { minutes: 24 * 60, label: "Daily" },
  { minutes: 7 * 24 * 60, label: "Weekly" },
];

export const keepCounts = [3, 5, 7, 10, 14, 30];

/** A frequency the API allows but the menu doesn't offer still shows, rather than reading as "Off". */
export function frequencyOptions(policy: SnapshotPolicy): { value: string; label: string }[] {
  const options = snapshotFrequencies.map((f) => ({
    value: f.minutes === null ? "off" : String(f.minutes),
    label: f.label,
  }));
  const current = policy.everyMinutes;
  if (current !== null && !snapshotFrequencies.some((f) => f.minutes === current)) {
    options.push({ value: String(current), label: `Every ${+(current / 60).toFixed(1)} hours` });
  }
  return options;
}

export function triggerLabel(trigger: Snapshot["trigger"]): string {
  switch (trigger) {
    case "manual":
      return "Manual";
    case "auto":
      return "Automatic";
    case "before_restore":
      return "Before restore";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
