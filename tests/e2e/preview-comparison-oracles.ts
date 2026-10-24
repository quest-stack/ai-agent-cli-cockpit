import type { ElectronApplication } from "@playwright/test";

export async function pngFixture(app: ElectronApplication, changed = false): Promise<Buffer> {
  const png = await app.evaluate(({ nativeImage }, changed) => {
    const width = 320, height = 200, pixels = Buffer.alloc(width * height * 4, 255);
    for (let y = 48; y < 80; y++) for (let x = 64; x < 96; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 0; pixels[offset + 1] = changed ? 0 : 180; pixels[offset + 2] = changed ? 255 : 0;
    }
    return nativeImage.createFromBitmap(pixels, { width, height }).toPNG().toString("base64");
  }, changed);
  return Buffer.from(png, "base64");
}

export function pdfFixture(label: string, secondLabel?: string): Buffer {
  const content = `BT /F1 24 Tf 45 740 Td (${label}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  if (secondLabel) {
    objects[1] = "<< /Type /Pages /Count 2 /Kids [3 0 R 6 0 R] >>";
    const second = `BT /F1 24 Tf 45 740 Td (${secondLabel}) Tj ET`;
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>", `<< /Length ${second.length} >>\nstream\n${second}\nendstream`);
  }
  let pdf = "%PDF-1.4\n"; const offsets: number[] = [];
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

/** Independent pixel oracle: measure the actual differing pixels, without region grouping. */
export async function pixelBounds(app: ElectronApplication, before: string, after: string, ignoredTopFraction = 0) {
  return app.evaluate(({ nativeImage }, input) => {
    const left = nativeImage.createFromDataURL(input.before), right = nativeImage.createFromDataURL(input.after);
    const size = left.getSize(), other = right.getSize();
    if (size.width !== other.width || size.height !== other.height) throw new Error("Capture dimensions differ");
    const a = left.toBitmap(), b = right.toBitmap();
    let minX = size.width, minY = size.height, maxX = -1, maxY = -1, pixels = 0;
    for (let y = Math.ceil(size.height * input.ignoredTopFraction); y < size.height; y++) for (let x = 0; x < size.width; x++) {
      const offset = (y * size.width + x) * 4;
      if (Math.max(...[0, 1, 2, 3].map((channel) => Math.abs(a[offset + channel] - b[offset + channel]))) <= 24) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); pixels++;
    }
    return { size, pixels, box: pixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null };
  }, { before, after, ignoredTopFraction });
}
