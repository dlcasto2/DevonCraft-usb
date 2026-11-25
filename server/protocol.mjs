const MAGIC = 0x54fd;
const MAX_PACKET = 4 * 1024 * 1024;

export function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function be16(value) {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

export function readU32BE(bytes, offset = 0) {
  return (((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0);
}

export function checksum(data) {
  let value = 0;
  for (const byte of data) {
    const first = (byte << 8) | (value >>> 8);
    value &= 255;
    const second = (((value & 15) << 4) ^ value) << 8;
    const third = second >>> 5;
    value = ((third >>> 7) ^ first ^ second ^ third) & 65535;
  }
  return value;
}

export function makePacket(data, options = {}) {
  if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
  if (data.length > 2048) throw new Error("TI-Nspire USB packet exceeds 2048 bytes.");

  const large = data.length > 254;
  const header = new Uint8Array(16);
  const view = new DataView(header.buffer);
  view.setUint16(0, MAGIC);
  view.setUint16(2, options.srcAddr ?? 0x6400);
  view.setUint16(4, options.srcSid ?? 0x4003);
  view.setUint16(6, options.dstAddr ?? 0x6401);
  view.setUint16(8, options.dstSid ?? 0x4003);

  const lengthPrefix = Uint8Array.of(data.length & 0xff, (data.length >>> 8) & 0xff, 0, 0);
  const payload = large ? concat(lengthPrefix, data) : data;
  view.setUint16(10, checksum(payload));
  header[12] = large ? 255 : data.length;
  header[13] = options.ack ?? 0;
  header[14] = options.seq ?? 1;
  header[15] = header.subarray(0, 15).reduce((sum, value) => (sum + value) & 0xff, 0);
  return concat(header, payload);
}

export function parsePacket(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) {
    throw new Error("Incomplete TI-Nspire USB packet.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== MAGIC) throw new Error("Invalid TI-Nspire NavNet packet marker.");

  const large = bytes[12] === 255;
  const length = large ? view.getUint32(16, true) : bytes[12];
  const offset = large ? 20 : 16;
  if (length > MAX_PACKET || bytes.length !== offset + length) {
    throw new Error("Invalid TI-Nspire USB packet length.");
  }
  const headSum = bytes.subarray(0, 15).reduce((sum, value) => (sum + value) & 0xff, 0);
  if (headSum !== bytes[15]) throw new Error("Invalid TI-Nspire packet header checksum.");
  const payload = bytes.subarray(16);
  if (checksum(payload) !== view.getUint16(10)) throw new Error("Invalid TI-Nspire packet data checksum.");

  return {
    srcAddr: view.getUint16(2),
    srcSid: view.getUint16(4),
    dstAddr: view.getUint16(6),
    dstSid: view.getUint16(8),
    ack: bytes[13],
    seq: bytes[14],
    data: bytes.subarray(offset),
    length
  };
}

export function pathName(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\\") ||
      path.includes("\0") || path.split("/").some(part => part === "." || part === "..")) {
    throw new Error("Invalid TI-Nspire path.");
  }
  return "/" + path.split("/").filter(Boolean).join("/");
}

export function pathField(path) {
  const normalized = pathName(path);
  const bytes = new TextEncoder().encode(normalized);
  if (bytes.length > 240) throw new Error("TI-Nspire path is too long.");
  return bytes.length < 8
    ? concat(bytes, new Uint8Array(9 - bytes.length))
    : concat(bytes, Uint8Array.of(0));
}

export function parseDirectoryEntry(data) {
  if (!(data instanceof Uint8Array) || data.length < 12 || data[0] !== 0x10) {
    throw new Error("Invalid TI-Nspire directory entry.");
  }
  const end = data.indexOf(0, 3);
  if (end <= 3) throw new Error("Invalid TI-Nspire directory entry name.");
  const name = new TextDecoder("utf-8", { fatal: false }).decode(data.subarray(3, end));
  const offset = Math.max(3 + 8, end) + 1;
  if (offset + 9 > data.length) throw new Error("Truncated TI-Nspire directory entry.");
  const size = readU32BE(data.subarray(offset, offset + 4));
  const date = readU32BE(data.subarray(offset + 4, offset + 8));
  return { name, size, date, isDir: data[offset + 8] === 1 };
}
