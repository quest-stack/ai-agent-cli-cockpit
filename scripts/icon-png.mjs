import { deflateSync } from "node:zlib";

function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  payload.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

/** Lossless format conversion of the existing Windows icon, no new artwork. */
export function icoToPng(ico) {
  if (ico.readUInt32LE(0) !== 0x00010000) throw new Error("Invalid ICO header.");
  const images = [];
  for (let index = 0; index < ico.readUInt16LE(4); index++) {
    const entry = 6 + index * 16;
    const offset = ico.readUInt32LE(entry + 12);
    const size = ico.readUInt32LE(entry + 8);
    images.push({ width: ico[entry] || 256, height: ico[entry + 1] || 256,
      content: ico.subarray(offset, offset + size) });
  }
  images.sort((left, right) => right.width * right.height - left.width * left.height);
  const { width, height, content } = images[0];
  if (content.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return content;
  const headerSize = content.readUInt32LE(0);
  if (headerSize !== 40 || content.readUInt16LE(14) !== 32 || content.readUInt32LE(16) !== 0
    || content.length < headerSize + width * height * 4) throw new Error("Expected uncompressed 32-bit icon bitmap.");
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = headerSize + ((height - 1 - y) * width + x) * 4;
      const target = y * (width * 4 + 1) + 1 + x * 4;
      rows[target] = content[source + 2];
      rows[target + 1] = content[source + 1];
      rows[target + 2] = content[source];
      rows[target + 3] = content[source + 3];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
