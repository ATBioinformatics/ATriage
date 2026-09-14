// Saved plans may predate array normalization or come from a goal-only import.
// An omitted optional field is still valid input and must render as unprovided.
type PlanInputKey = "goal" | "current" | "timing" | "limits" | "resources" | "outcome";
type PlanInputLike = Partial<Record<PlanInputKey, {
  choices?: readonly string[] | null;
  detail?: string | null;
} | null>>;
const planInputKeys: PlanInputKey[] = ["goal", "current", "timing", "limits", "resources", "outcome"];

// The editor needs a writable array even for plans saved before choices were
// normalized. Keep this at the UI boundary so old account data cannot crash it.
export function normalizePlanInput(input?: PlanInputLike | null): Record<PlanInputKey, {choices: string[]; detail: string}> {
  return Object.fromEntries(planInputKeys.map((key) => {
    const field = input?.[key];
    return [key, {
      choices: Array.isArray(field?.choices) ? [...field.choices] : [],
      detail: typeof field?.detail === "string" ? field.detail : "",
    }];
  })) as Record<PlanInputKey, {choices: string[]; detail: string}>;
}

export function describePlanField(field?: {
  choices?: readonly string[] | null;
  detail?: string | null;
} | null): string {
  return [...(field?.choices ?? []), field?.detail]
    .filter(Boolean)
    .join("；") || "未提供";
}
