import { test } from "node:test";
import assert from "node:assert/strict";
import { due } from "./deadline.ts";
const task = (deadline, zone = "Asia/Shanghai", status = "open") => ({
  deadline,
  zone,
  status,
});
test("date only remains open until local end of day", () => {
  assert.equal(
    due(task("2026-09-13"), Date.parse("2026-09-13T15:59:58Z")),
    "soon",
  );
  assert.equal(
    due(task("2026-09-13"), Date.parse("2026-09-13T16:00:00Z")),
    "overdue",
  );
});
test("exact times and 24 hour boundary", () => {
  const t = task("2026-09-14T09:00");
  assert.equal(due(t, Date.parse("2026-09-13T00:59:59Z")), "");
  assert.equal(due(t, Date.parse("2026-09-13T01:00:00Z")), "soon");
  assert.equal(due(t, Date.parse("2026-09-14T01:00:01Z")), "overdue");
});
test("completed and skipped tasks never remind", () => {
  for (const status of ["done", "skipped"])
    assert.equal(
      due(task("2020-01-01", "Asia/Shanghai", status), Date.now()),
      "",
    );
});
test("no deadline gives no risk prediction", () =>
  assert.equal(due(task(""), Date.now()), ""));
test("timezone retained per task", () => {
  const now = Date.parse("2026-09-13T16:01:00Z");
  assert.equal(due(task("2026-09-13", "Asia/Shanghai"), now), "overdue");
  assert.equal(due(task("2026-09-13", "America/New_York"), now), "soon");
});
test("DST spring transition respects elapsed time", () => {
  assert.equal(
    due(
      task("2026-03-08T12:00", "America/New_York"),
      Date.parse("2026-03-07T16:30:00Z"),
    ),
    "soon",
  );
});
