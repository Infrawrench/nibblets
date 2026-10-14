import { describe, expect, it } from "vitest";
import { describeCron, fromCron, toCron, type Repeat } from "./cron.ts";

describe("cron helpers", () => {
  const cases: [Repeat, string][] = [
    [{ kind: "minutes", every: 15 }, "*/15 * * * *"],
    [{ kind: "hourly", minute: 30 }, "30 * * * *"],
    [{ kind: "daily", time: "09:00" }, "0 9 * * *"],
    [{ kind: "weekdays", days: [1, 2, 3, 4, 5], time: "08:30" }, "30 8 * * 1,2,3,4,5"],
    [{ kind: "monthly", day: 1, time: "07:05" }, "5 7 1 * *"],
  ];

  it("round-trips the friendly shapes", () => {
    for (const [repeat, cron] of cases) {
      expect(toCron(repeat)).toBe(cron);
      expect(fromCron(cron)).toEqual(repeat);
    }
  });

  it("describes schedules in plain words", () => {
    expect(describeCron("0 9 * * *")).toBe("Every day at 09:00");
    expect(describeCron("30 8 * * 1-5")).toBe("Weekdays at 08:30");
    expect(describeCron("0 10 * * 0,6")).toBe("Weekends at 10:00");
    expect(describeCron("0 18 * * 1,3")).toBe("Monday and Wednesday at 18:00");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 * * * *")).toBe("Every hour, on the hour");
    expect(describeCron("0 9 22 * *")).toBe("The 22nd of every month at 09:00");
    expect(describeCron("0 9 1 1 *")).toBe("Custom: 0 9 1 1 *");
  });
});
