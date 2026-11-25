import { deflateSync } from "node:zlib";

function isWhitespace(byte) {
  return byte === 9 || byte === 10 || byte === 11 || byte === 12 || byte === 13 || byte === 32;
}

function readToken(buffer, cursor) {
  let position = cursor;
  while (position < buffer.length) {
    if (isWhitespace(buffer[position])) {
      position++;
      continue;
    }
    if (buffer[position] === 35) {
      while (position < buffer.length && buffer[position] !== 10 && buffer[position] !== 13) position++;
      continue;
    }
    break;
  }
  const start = position;
  while (position < buffer.length && !isWhitespace(buffer[position]) && buffer[position] !== 35) position++;
  if (position === start) throw new Error("Malformed PPM header.");
  return { token: buffer.toString("ascii", start, position), next: position };
}

export function parsePpm(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let cursor = 0;
  const magic = readToken(buffer, cursor); cursor = magic.next;
  const widthToken = readToken(buffer, cursor); cursor = widthToken.next;
  const heightToken = readToken(buffer, cursor); cursor = heightToken.next;
  const maxToken = readToken(buffer, cursor); cursor = maxToken.next;
  const width = Number(widthToken.token);
  const height = Number(heightToken.token);
  const maxValue = Number(maxToken.token);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
      width > 4096 || height > 4096 || width * height > 4_000_000 ||
      !Number.isInteger(maxValue) || maxValue < 1 || maxValue > 65535) {
    throw new Error("PPM dimensions or channel range are invalid.");
  }

  const pixelCount = width * height * 3;
  const rgb = Buffer.allocUnsafe(pixelCount);
  if (magic.token === "P6") {
    // Binary PPM has exactly one whitespace delimiter (CRLF counts as one)
    // between maxval and the pixel payload. Do not skip further bytes: pixel
    // channel values may themselves equal ASCII whitespace values.
    if (cursor >= buffer.length || !isWhitespace(buffer[cursor])) throw new Error("PPM binary payload delimiter is missing.");
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;
    else cursor += 1;
    const bytesPerSample = maxValue < 256 ? 1 : 2;
    const expected = pixelCount * bytesPerSample;
    if (buffer.length - cursor < expected) throw new Error("PPM pixel data is truncated.");
    if (bytesPerSample === 1) {
      for (let i = 0; i < pixelCount; i++) rgb[i] = Math.round(buffer[cursor + i] * 255 / maxValue);
    } else {
      for (let i = 0; i < pixelCount; i++) {
        const sample = buffer.readUInt16BE(cursor + i * 2);
        rgb[i] = Math.round(sample * 255 / maxValue);
      }
    }
  } else if (magic.token === "P3") {
    for (let i = 0; i < pixelCount; i++) {
      const item = readToken(buffer, cursor); cursor = item.next;
      const value = Number(item.token);
      if (!Number.isInteger(value) || value < 0 || value > maxValue) throw new Error("PPM channel sample is invalid.");
      rgb[i] = Math.round(value * 255 / maxValue);
    }
  } else {
    throw new Error(`Unsupported PPM format ${magic.token}; expected P6 or P3.`);
  }
  return { width, height, rgb };
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), 8 + data.length);
  return chunk;
}

export function encodePng({ width, height, rgb }) {
  if (!Buffer.isBuffer(rgb) || rgb.length !== width * height * 3) throw new Error("Invalid RGB image buffer.");
  const scanlines = Buffer.allocUnsafe(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    scanlines[row] = 0;
    rgb.copy(scanlines, row + 1, y * width * 3, (y + 1) * width * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;  // bit depth
  header[9] = 2;  // RGB truecolor
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}
