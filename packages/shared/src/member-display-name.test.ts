import { describe, expect, it } from "vitest";

import { isValidMemberDisplayName } from "./member-display-name";

describe("administrator display names", () => {
  it.each(["Ярослав Чиганов", "  Alan  ", "Jean-Luc", "a".repeat(255)])(
    "accepts %j",
    (name) => {
      expect(isValidMemberDisplayName(name)).toBe(true);
    },
  );
  it.each([
    "",
    "  ",
    "ab",
    "a".repeat(256),
    "ts01@trisoft.ru",
    "Name <user@example.com>",
    "Name\nSurname",
    "Name\u0000Surname",
    "Name\u007fSurname",
  ])("rejects %j", (name) => {
    expect(isValidMemberDisplayName(name)).toBe(false);
  });
});
