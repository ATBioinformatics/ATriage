type Node = {
  id: string;
  mode: string;
  hours?: number;
  hoursHigh?: number;
  waitDays: number;
  dependsOn: string[];
};
export function hourSchedule(
  nodes: Node[],
  weeklyHours: number,
  upper = false,
): Map<string, { start: number; end: number }> | null {
  if (
    !Number.isFinite(weeklyHours) ||
    weeklyHours <= 0 ||
    nodes.some((n) => n.mode !== "self" || !n.hours)
  )
    return null;
  const result = new Map<string, { start: number; end: number }>();
  let available = 0;
  for (let pass = 0; pass < nodes.length; pass++)
    for (const n of nodes) {
      if (result.has(n.id) || !n.dependsOn.every((id) => result.has(id)))
        continue;
      const start = Math.max(
        available,
        0,
        ...n.dependsOn.map((id) => result.get(id)!.end),
      );
      available =
        start +
        ((upper ? n.hoursHigh || n.hours! : n.hours!) / weeklyHours) * 7;
      result.set(n.id, { start, end: available + n.waitDays });
    }
  return result.size === nodes.length ? result : null;
}
