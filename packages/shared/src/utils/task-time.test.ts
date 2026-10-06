import { afterEach, describe, expect, it, vi } from "vitest";

import { convertDueDateFiltersToRanges } from "./dueDateFilters";
import {
  formatTaskDeadline,
  parseTaskDateTime,
  taskDateTimeInput,
} from "./task-time";

afterEach(() => vi.useRealTimers());
describe("Moscow minute deadlines", () => {
  it("round-trips a precise instant", () => {
    const date = parseTaskDateTime("2026-10-07T15:30");
    if (!date) throw new Error("Expected a valid date");
    expect(date.toISOString()).toBe("2026-10-07T12:30:00.000Z");
    expect(taskDateTimeInput(date)).toBe("2026-10-07T15:30");
    expect(formatTaskDeadline(date)).toContain("15:30");
  });
  it.each([
    "2026-02-30T15:30",
    "2026-10-07T25:30",
    "2026-10-07",
    "2026-10-07T15:30:10",
    "2026-10-07T15:60",
    "bad",
  ])("rejects invalid or imprecise input: %s", (value) =>
    expect(parseTaskDateTime(value)).toBeNull(),
  );
  it("uses Moscow midnight, not browser/server local midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T22:30:00Z"));
    const [today] = convertDueDateFiltersToRanges(["today"]);
    expect(today?.startDate?.toISOString()).toBe("2026-10-06T21:00:00.000Z");
    expect(today?.endDate?.toISOString()).toBe("2026-10-07T21:00:00.000Z");
  });
  it("overdue ends at the current minute, not start of day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:30:00Z"));
    expect(
      convertDueDateFiltersToRanges(["overdue"])[0]?.endDate?.toISOString(),
    ).toBe("2026-10-07T12:30:00.000Z");
  });
});
