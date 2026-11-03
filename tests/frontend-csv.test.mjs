import test from "node:test";
import assert from "node:assert/strict";
import { csvCell, toCsv } from "../client/csv.js";

test("CSV preserves cell boundaries, quotes, line breaks and exact decimal strings", () => {
  assert.equal(csvCell('A,"B"\nC'), '"A,""B""\nC"');
  assert.equal(csvCell("9.900100000000000001"), '"9.900100000000000001"');
  assert.equal(
    toCsv(["订单", "金额"], [["单,一", "9.9001"]]),
    '\ufeff"订单","金额"\r\n"单,一","9.9001"',
  );
});

test("CSV neutralizes formula prefixes including leading whitespace/control characters", () => {
  for (const value of [
    "=1+1",
    "+SUM(A1)",
    "-1+2",
    "@SUM(A1)",
    "  =1",
    "\t=1",
    "\r=1",
    "\n@cmd",
    "\ufeff=1",
  ]) {
    assert.ok(csvCell(value).startsWith("\"'"), JSON.stringify(value));
  }
  assert.equal(csvCell("ordinary"), '"ordinary"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell("\0=1"), '"\'=1"');
});
