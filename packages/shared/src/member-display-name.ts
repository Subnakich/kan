// Shared by the administrator form and API. The database column is varchar(255).
export function isValidMemberDisplayName(value: string): boolean {
  const name = value.trim();
  return (
    name.length >= 3 &&
    name.length <= 255 &&
    !name.includes("@") &&
    !Array.from(name).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}
