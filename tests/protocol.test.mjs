import test from "node:test";
import assert from "node:assert/strict";
import { makePacket, parsePacket, pathName, pathField } from "../server/protocol.mjs";

test("NavNet packet round-trips a short payload", () => {
  const original = Uint8Array.from([0x64, 0x01, 0xff, 0x00]);
  const encoded = makePacket(original, { srcSid: 0x4003, dstSid: 0x4003, seq: 7 });
  const decoded = parsePacket(encoded);
  assert.equal(decoded.srcSid, 0x4003);
  assert.equal(decoded.dstSid, 0x4003);
  assert.equal(decoded.seq, 7);
  assert.deepEqual(Array.from(decoded.data), Array.from(original));
});

test("NavNet packet round-trips an extended payload", () => {
  const original = Uint8Array.from({ length: 512 }, (_, index) => index & 0xff);
  const decoded = parsePacket(makePacket(original));
  assert.deepEqual(Buffer.from(decoded.data), Buffer.from(original));
});

test("path validation blocks traversal", () => {
  assert.equal(pathName("/documents/ndless"), "/documents/ndless");
  assert.throws(() => pathName("/documents/../system"));
  assert.throws(() => pathName("/documents\\system"));
});

test("short calculator paths are null padded", () => {
  const encoded = pathField("/abc");
  assert.equal(encoded.length, 9);
  assert.deepEqual(Array.from(encoded.slice(0, 4)), [47, 97, 98, 99]);
  assert.equal(encoded[4], 0);
});
