import { test } from "node:test";
import assert from "node:assert/strict";
import { describePlanField } from "./plan-input.ts";

test("goal-only imported plans tolerate all six null choice arrays", () => {
  const fields = [{ choices: null, detail: "目标原话" }, ...Array.from({length:5}, () => ({ choices:null, detail:"" }))];
  assert.deepEqual(fields.map(describePlanField), ["目标原话", ...Array(5).fill("未提供")]);
});
test("older absent optional fields render without crashing", () => {
  for (const field of [undefined, null, {}, {choices:[], detail:""}]) {
    assert.equal(describePlanField(field), "未提供");
  }
});
test("provided choices and uncertain original details remain intact", () => {
  const field = { choices:["有同事可以协助"], detail:"小王可能帮忙" };
  assert.equal(describePlanField(field), "有同事可以协助；小王可能帮忙");
  assert.deepEqual(field, {choices:["有同事可以协助"], detail:"小王可能帮忙"});
});
