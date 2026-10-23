import { z } from "zod";

/**
 * Snapshots: a nibblet's home folder and its state (thread, its own
 * memories, schedules, instructions, heartbeats, tools) at a moment, to roll
 * back or forward to.
 */

export const SnapshotTrigger = z.enum(["manual", "auto", "before_restore"]);
export type SnapshotTrigger = z.infer<typeof SnapshotTrigger>;

export const Snapshot = z.object({
  id: z.string(),
  nibbletId: z.string(),
  createdAt: z.iso.datetime(),
  label: z.string().nullable(),
  trigger: SnapshotTrigger,
  /** The compressed home folder and state together, in bytes. */
  sizeBytes: z.int(),
  /** Messages in the thread when it was taken. */
  messageCount: z.int(),
});
export type Snapshot = z.infer<typeof Snapshot>;

/** Automatic snapshots: how often, and how many to keep. Null `everyMinutes` turns them off. */
export const SnapshotPolicy = z.object({
  everyMinutes: z
    .int()
    .min(60)
    .max(30 * 24 * 60)
    .nullable(),
  keep: z.int().min(1).max(100),
});
export type SnapshotPolicy = z.infer<typeof SnapshotPolicy>;

/**
 * Daily, keeping a week. Unchanged nibblets aren't snapshotted again, so a
 * quiet one costs one snapshot, not seven.
 */
export const defaultSnapshotPolicy: SnapshotPolicy = { everyMinutes: 24 * 60, keep: 7 };

export const SnapshotActivity = z.enum(["snapshotting", "restoring"]).nullable();
export type SnapshotActivity = z.infer<typeof SnapshotActivity>;

export const SnapshotTimeline = z.object({
  snapshots: z.array(Snapshot),
  /**
   * The snapshot the nibblet was last restored to, and whether anything has
   * happened since. Null when it hasn't been restored.
   */
  current: z.object({ snapshotId: z.string(), changedSince: z.boolean() }).nullable(),
  /** Something in progress for this nibblet right now. */
  activity: SnapshotActivity,
});
export type SnapshotTimeline = z.infer<typeof SnapshotTimeline>;

/**
 * Caches inside a home folder that rebuild themselves, so aren't worth
 * snapshotting: relative to the folder the home is in, which is called
 * `nibblet` on every machine.
 */
export const HOME_ARCHIVE_EXCLUDES = [
  "nibblet/.cache",
  "nibblet/.npm/_cacache",
  // macOS's caches.
  "nibblet/Library/Caches",
  // The browser's profile, in the guard's home (and where it was before the
  // guard), and Edge's and Chrome's in Windows and macOS VMs.
  ...["nibblet/.guard/.config/chromium", "nibblet/.config/chromium", "nibblet/.browser"].flatMap(
    (profile) => [
      `${profile}/*/Cache`,
      `${profile}/*/Code Cache`,
      `${profile}/*/GPUCache`,
      `${profile}/*/Service Worker/CacheStorage`,
    ],
  ),
];
