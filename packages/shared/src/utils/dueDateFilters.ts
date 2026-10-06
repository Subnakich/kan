import { parseTaskDateTime, taskDateTimeInput } from "./task-time";

const addDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * 86400000);

export type DueDateFilterKey =
  | "overdue"
  | "today"
  | "tomorrow"
  | "next-week"
  | "next-month"
  | "no-due-date";

export interface DueDateFilter {
  startDate?: Date;
  endDate?: Date;
  hasNoDueDate?: boolean;
}

export const convertDueDateFiltersToRanges = (
  filters: DueDateFilterKey[],
): DueDateFilter[] => {
  if (!filters.length) return [];

  const now = new Date();
  const today = parseTaskDateTime(
    `${taskDateTimeInput(now).slice(0, 10)}T00:00`,
  );
  if (!today) throw new Error("Cannot calculate Moscow midnight");
  const tomorrow = addDays(today, 1);
  const nextWeekEnd = addDays(today, 8);
  const nextMonthEnd = addDays(today, 31);

  return filters.map((filter) => {
    switch (filter) {
      case "overdue":
        return {
          endDate: now,
        };
      case "today":
        return {
          startDate: today,
          endDate: tomorrow,
        };
      case "tomorrow":
        return {
          startDate: tomorrow,
          endDate: addDays(tomorrow, 1),
        };
      case "next-week": {
        return {
          startDate: today,
          endDate: nextWeekEnd,
        };
      }
      case "next-month": {
        return {
          startDate: nextWeekEnd,
          endDate: nextMonthEnd,
        };
      }
      case "no-due-date":
        return {
          hasNoDueDate: true,
        };
      default:
        return {};
    }
  });
};
