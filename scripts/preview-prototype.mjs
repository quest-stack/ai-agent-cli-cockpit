// Browser-only UI trial with trusted generated samples, never an arbitrary-file server.
// Run: node scripts/preview-prototype.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "vite";

const directory = await mkdtemp(join(tmpdir(), "cockpit-preview-ui-"));
const pdfPath = join(directory, "overview.pdf");
const videoPath = join(directory, "walkthrough.mp4");

// A two-page, entirely fictional technical fixture. No binary assets enter Git.
const pdfObjects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
  "",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
  "",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
const pdfPages = [
  "0.965 0.957 0.93 rg 0 0 595 842 re f 0.12 0.22 0.17 rg BT /F1 11 Tf 50 775 Td (SAMPLE STUDIO / PROJECT NOTE) Tj /F1 32 Tf 0 -85 Td (Space for good work.) Tj /F1 13 Tf 0 -45 Td (A small change can make the working day better.) Tj ET 0.72 0.81 0.74 rg 50 285 495 290 re f 0.38 0.53 0.43 rg 100 320 100 160 re f 0.57 0.43 0.30 rg 210 355 245 15 re f 230 290 12 65 re f 420 290 12 65 re f 0.12 0.22 0.17 rg BT /F1 11 Tf 50 190 Td (01 / WORKSPACE) Tj 0 -30 Td (Layout, light and a little breathing room.) Tj 0 -90 Td (UI TRIAL - generated sample, page 1 of 2) Tj ET",
  "0.965 0.957 0.93 rg 0 0 595 842 re f 0.12 0.22 0.17 rg BT /F1 11 Tf 50 775 Td (SAMPLE STUDIO / WORKFLOW) Tj /F1 30 Tf 0 -85 Td (Capture. Paste. Ask.) Tj /F1 14 Tf 0 -70 Td (1. Capture the screen you want to change.) Tj 0 -45 Td (2. Paste the screenshot into an AI pane.) Tj 0 -45 Td (3. Describe the change and review the result.) Tj /F1 11 Tf 0 -210 Td (Keep your conversation and your work in the same view.) Tj 0 -220 Td (UI TRIAL - generated sample, page 2 of 2) Tj ET",
];
for (const [index, content] of pdfPages.entries()) {
  pdfObjects[index === 0 ? 3 : 5] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
}
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [index, object] of pdfObjects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(pdfPath, pdf, "utf8");

// ffmpeg is an optional local fixture-generation tool, not an application dependency.
const font = ["C:/Windows/Fonts/segoeui.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find(existsSync);
const fontOption = font ? `fontfile='${font.replace(":", "\\:")}'` : null;
const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x11151b:s=960x540:r=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "12", "-vf", [
  "drawbox=x=40:y=40:w=880:h=460:color=0x1a1e25:t=fill",
  "drawbox=x=75:y=150:w=375:h=285:color=0x254636:t=fill",
  "drawbox=x=475:y=150:w=410:h=285:color=0xe9e6d7:t=fill",
  ...(fontOption ? [
    `drawtext=${fontOption}:text='CLI COCKPIT':x=75:y=70:fontsize=26:fontcolor=0xf5a623`,
    `drawtext=${fontOption}:text='Capture. Paste. Ask.':x=105:y=210:fontsize=28:fontcolor=white`,
    `drawtext=${fontOption}:text='Review your work':x=505:y=230:fontsize=27:fontcolor=0x254636`,
    `drawtext=${fontOption}:text='>':x='75+mod(t*60,760)':y=460:fontsize=24:fontcolor=0xf5a623`,
  ] : []),
].join(","), "-af", "volume=0.02", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-y", videoPath], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let ffmpegError = "";
ffmpeg.stderr.on("data", (data) => { ffmpegError = (ffmpegError + data.toString()).slice(-2000); });
const videoReady = await new Promise((resolve) => {
  ffmpeg.on("error", () => resolve(false));
  ffmpeg.on("exit", (code) => resolve(code === 0));
});
if (!videoReady) console.warn("Sample MP4 unavailable; install ffmpeg locally to generate it.", ffmpegError);

const fixtures = new Map([
  ["/__preview-sample/overview.pdf", { path: pdfPath, type: "application/pdf" }],
  ...(videoReady ? [["/__preview-sample/walkthrough.mp4", { path: videoPath, type: "video/mp4" }]] : []),
]);
const server = await createServer({ server: { host: "127.0.0.1", port: 4174, strictPort: true, open: false }, plugins: [{
  name: "cockpit-preview-trusted-samples",
  configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const fixture = fixtures.get(path);
      if (!fixture) { next(); return; }
      if (req.method !== "GET" && req.method !== "HEAD") { res.statusCode = 405; res.end(); return; }
      try {
        const data = await readFile(fixture.path);
        const range = /^bytes=(\d+)-(\d*)$/u.exec(req.headers.range ?? "");
        const start = range ? Number(range[1]) : 0;
        const end = range && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
        res.setHeader("Content-Type", fixture.type);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (start > end || start >= data.length) { res.statusCode = 416; res.setHeader("Content-Range", `bytes */${data.length}`); res.end(); return; }
        if (range) { res.statusCode = 206; res.setHeader("Content-Range", `bytes ${start}-${end}/${data.length}`); }
        res.setHeader("Content-Length", end - start + 1);
        res.end(req.method === "HEAD" ? undefined : data.subarray(start, end + 1));
      } catch { res.statusCode = 500; res.end("Sample unavailable"); }
    });
  },
}] });
await server.listen();
console.log("Preview UI trial: http://127.0.0.1:4174/?preview=prototype");
console.log("Samples are generated in an OS temporary directory; no app state or CLI settings are changed.");
