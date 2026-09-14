// Saved plans may predate array normalization or come from a goal-only import.
// An omitted optional field is still valid input and must render as unprovided.
export function describePlanField(field?: {
  choices?: readonly string[] | null;
  detail?: string | null;
} | null): string {
  return [...(field?.choices ?? []), field?.detail]
    .filter(Boolean)
    .join("；") || "未提供";
}
