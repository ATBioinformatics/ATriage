type DeadlineTask = { deadline: string; zone: string; status: string };
export function due(t: DeadlineTask, now: number) {
  if (!t.deadline || t.status !== "open") return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: t.zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(now));
  const localNow = parts.replace(" ", "T");
  const target =
    t.deadline.length === 10 ? t.deadline + "T23:59:59" : t.deadline + ":00";
  if (localNow > target) return "overdue"; // Calculate the wall-clock target offset iteratively, including DST transitions.
  let ts = Date.parse(target + "Z");
  for (let i = 0; i < 3; i++) {
    const wall = new Intl.DateTimeFormat("sv-SE", {
      timeZone: t.zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .format(new Date(ts))
      .replace(" ", "T");
    ts += Date.parse(target + "Z") - Date.parse(wall + "Z");
  }
  return ts - now <= 86400000 ? "soon" : "";
}
