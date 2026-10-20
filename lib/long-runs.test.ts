import { expect, test } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import { longRuns, runsHolding } from "./long-runs";
import { MOVED_OUT, hunkPatch } from "./diff-fixtures.test-support";

const parse = (patch: string) => parsePatchFiles(patch).flatMap((p) => p.files)[0]!;

test("a block deleting 40 or more lines past the ones its additions pair with folds all but its first 3", () => {
  expect(longRuns(parse(hunkPatch("infra/s3.tf", MOVED_OUT)))).toEqual([
    { first: 14, last: 190, anchor: 16, from: 17, to: 190, count: 174 },
    { first: 195, last: 254, anchor: 197, from: 198, to: 254, count: 57 },
  ]);
});

test("39 unpaired deleted lines don't fold, 40 do, wherever the hunk starts", () => {
  expect(longRuns(parse(hunkPatch("a.ts", [{ same: 1 }, { del: 39, add: 0 }, { same: 1 }])))).toEqual([]);
  expect(longRuns(parse(hunkPatch("a.ts", [{ same: 1 }, { del: 45, add: 5 }, { same: 1 }], 100)))).toEqual([
    { first: 106, last: 145, anchor: 108, from: 109, to: 145, count: 37 },
  ]);
});

test("added lines never fold: they're the change under review", () => {
  expect(longRuns(parse(hunkPatch("a.ts", [{ same: 1 }, { del: 0, add: 300 }, { same: 1 }])))).toEqual([]);
  expect(longRuns(parse(hunkPatch("a.ts", [{ same: 1 }, { del: 5, add: 100 }, { same: 1 }])))).toEqual([]);
});

test("a run holds the lines it folds and the line its fold row is under, not the lines above", () => {
  const runs = longRuns(parse(hunkPatch("infra/s3.tf", MOVED_OUT)));
  expect(runsHolding(runs, [15])).toEqual([]);
  expect(runsHolding(runs, [16])).toEqual([0]);
  expect(runsHolding(runs, [100, 200])).toEqual([0, 1]);
  expect(runsHolding(runs, [191, 255])).toEqual([]);
});
