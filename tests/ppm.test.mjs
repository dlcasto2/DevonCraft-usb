import test from "node:test";
import assert from "node:assert/strict";
import { parsePpm, encodePng } from "../server/ppm.mjs";

test("parses binary P6 PPM and converts to PNG", () => {
  const header = Buffer.from("P6\n2 1\n255\n", "ascii");
  const pixels = Buffer.from([255, 0, 0, 0, 255, 0]);
  const parsed = parsePpm(Buffer.concat([header, pixels]));
  assert.equal(parsed.width, 2);
  assert.equal(parsed.height, 1);
  assert.deepEqual(Array.from(parsed.rgb), [255, 0, 0, 0, 255, 0]);
  const png = encodePng(parsed);
  assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("parses ASCII P3 PPM with comments", () => {
  const parsed = parsePpm(Buffer.from("P3\n# test image\n1 1\n15\n15 7 0\n", "ascii"));
  assert.deepEqual(Array.from(parsed.rgb), [255, 119, 0]);
});

test("rejects truncated P6 data", () => {
  assert.throws(() => parsePpm(Buffer.from("P6\n1 1\n255\n\x00\x00", "binary")), /truncated/i);
});
