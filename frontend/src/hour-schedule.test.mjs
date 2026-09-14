import { test } from "node:test";
import assert from "node:assert/strict";
import { hourSchedule } from "./hour-schedule.ts";
const node = (id, hours, waitDays = 0, dependsOn = []) => ({
  id,
  hours,
  hoursHigh: hours * 2,
  waitDays,
  dependsOn,
  mode: "self",
});
test("hours retain subday precision and respect weekly capacity", () => {
  const r = hourSchedule([node("a", 2), node("b", 4)], 6);
  assert.ok(Math.abs(r.get("a").end - 7 / 3) < 1e-10);
  assert.ok(Math.abs(r.get("b").end - 7) < 1e-10);
  assert.ok(
    Math.abs(hourSchedule([node("a", 2)], 6, true).get("a").end - 14 / 3) <
      1e-10,
  );
});
test("independent work overlaps waiting but dependent work waits", () => {
  const r = hourSchedule(
    [node("a", 6, 7), node("b", 6), node("c", 6, 0, ["a", "b"])],
    6,
  );
  assert.deepEqual(r.get("a"), { start: 0, end: 14 });
  assert.deepEqual(r.get("b"), { start: 7, end: 14 });
  assert.deepEqual(r.get("c"), { start: 14, end: 21 });
});
test("unknown capacities, missing effort and invalid dependency graphs do not invent dates", () => {
  assert.equal(hourSchedule([node("a", 2)], 0), null);
  assert.equal(hourSchedule([{ ...node("a", 2), mode: "delegate" }], 6), null);
  assert.equal(hourSchedule([node("a", 0)], 6), null);
  assert.equal(hourSchedule([node("a", 2, 0, ["b"])], 6), null);
});
