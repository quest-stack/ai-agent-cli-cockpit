import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

import type { CockpitApi } from "../../src/shared/types";

interface FrameSample {
  working: boolean;
  composing: boolean;
  anchorFound: boolean;
  offsetY: number | null;
  lineHeight: number;
  textLength: number;
  hidden: boolean;
}

// 実際のモデルへ依頼を送るため通常の E2E では実行しない。
// COCKPIT_LIVE_CODEX_TEST=1 で明示的に起動する。
test("実際のCodexの2・3ターン目の応答中も入力位置と文字が保たれる", async () => {
  test.skip(process.env.COCKPIT_LIVE_CODEX_TEST !== "1", "実Codexを使用する手動検証");
  test.setTimeout(360_000);

  const artifactDirectory = await mkdtemp(join(tmpdir(), "cockpit-live-codex-"));
  const workspace = join(artifactDirectory, "workspace");
  await mkdir(workspace);
  const executablePath = process.env.COCKPIT_TEST_EXECUTABLE ?? resolve(
    "release/win-arm64-unpacked/CLI Cockpit.exe",
  );
  const app = await electron.launch({
    executablePath,
    env: { ...process.env, COCKPIT_USER_DATA: join(artifactDirectory, "user-data") },
  });
  console.log(`Live Codex evidence: ${artifactDirectory}`);
  const page = await app.firstWindow();

  try {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByTestId("launcher")).toBeVisible();
    const tour = page.getByTestId("tour-overlay");
    if (await tour.isVisible()) {
      await page.getByRole("button", { name: "スキップ" }).click();
    }
    await page.getByRole("combobox", { name: "プロジェクト" }).fill(workspace);
    await page.getByLabel("CLI").selectOption("codex");
    await page.getByLabel("セッション名").fill("Live input test");
    await page.getByRole("button", { name: /Start Session/u }).click();
    const helper = page.locator(".xterm-helper-textarea");
    const rows = page.locator(".xterm-rows");
    const screenText = async (): Promise<string> => (await rows.textContent()) ?? "";
    await expect.poll(screenText, { timeout: 90_000 }).toMatch(/Ask Codex|trust the contents/u);
    if (/trust the contents/u.test(await screenText())) {
      // このテストが作成した空の作業フォルダだけを信頼する。
      await page.keyboard.press("Enter");
      await expect.poll(screenText, { timeout: 60_000 }).toMatch(/Ask Codex/u);
    }
    await expect.poll(screenText, { timeout: 60_000 }).not.toMatch(/model:\s+loading/iu);
    await helper.focus();

    const probe = await page.evaluateHandle(() => {
      const state = {
        running: true,
        prefix: "",
        samples: [] as FrameSample[],
        chunksWhileComposing: 0,
        syncStarts: 0,
      };
      const api = (window as unknown as { cockpit: CockpitApi }).cockpit;
      const unsubscribe = api.onPtyData(({ data }) => {
        if (!state.prefix) return;
        state.syncStarts += data.split("\x1b[?2026h").length - 1;
        if (document.querySelector(".composition-view.active")) {
          state.chunksWhileComposing += 1;
        }
      });
      const tick = (): void => {
        if (!state.running) {
          unsubscribe();
          return;
        }
        if (state.prefix) {
          const screen = document.querySelector<HTMLElement>(".xterm-screen");
          const terminal = document.querySelector<HTMLElement>(".xterm");
          const textarea = document.querySelector<HTMLElement>(".xterm-helper-textarea");
          const view = document.querySelector<HTMLElement>(".composition-view");
          const rowElements = [...document.querySelectorAll<HTMLElement>(".xterm-rows > div")];
          const text = rowElements.map((row) => row.textContent ?? "").join("\n");
          const anchor = rowElements.findLast((row) => row.textContent?.includes(state.prefix));
          const composing = view?.classList.contains("active") ?? false;
          const top = Number.parseFloat(textarea?.style.top ?? "");
          const anchorTop = anchor && screen
            ? anchor.getBoundingClientRect().top - screen.getBoundingClientRect().top
            : Number.NaN;
          const style = terminal ? window.getComputedStyle(terminal) : null;
          state.samples.push({
            working: /Working|esc to interrupt/iu.test(text),
            composing,
            anchorFound: Boolean(anchor),
            offsetY: Number.isFinite(top) && Number.isFinite(anchorTop) ? top - anchorTop : null,
            lineHeight: Number.parseFloat(view?.style.lineHeight ?? "0"),
            textLength: text.trim().length,
            hidden: style?.visibility === "hidden" || style?.opacity === "0",
          });
        }
        window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
      return state;
    });

    const cdp = await page.context().newCDPSession(page);
    const frameWrites: Promise<void>[] = [];
    let phase = "";
    let frameCount = 0;
    const frameMetadata: { file: string; phase: string; timestamp: number }[] = [];
    cdp.on("Page.screencastFrame", (event) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
      if (!phase) return;
      const file = `frame-${String(frameCount++).padStart(4, "0")}.jpg`;
      frameMetadata.push({ file, phase, timestamp: event.metadata.timestamp ?? 0 });
      frameWrites.push(writeFile(join(artifactDirectory, file), Buffer.from(event.data, "base64")));
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg", quality: 80, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1,
    });

    const isWorking = async (): Promise<boolean> => /Working|esc to interrupt/iu.test(await screenText());
    const sendPrompt = async (lines: number, marker: string): Promise<void> => {
      await helper.focus();
      const prompt = `Display-only terminal test in an empty temporary folder. Do not use any tools, access files, run commands, or ask questions. Output exactly ${lines} numbered lines. Each line must contain a unique short English sentence about a fictional blue square. After all lines, output ${marker} on its own line.`;
      await page.keyboard.insertText(prompt);
      // insertText から PTY への配送は非同期。入力欄に届く前の Enter は空送信になる。
      await expect(rows).toContainText(marker);
      await page.keyboard.press("Enter");
      await page.screenshot({ path: join(artifactDirectory, `${marker}-sent.png`) });
      await expect.poll(isWorking, { timeout: 60_000 }).toBe(true);
    };
    const waitForAnswer = async (marker: string): Promise<void> => {
      await expect.poll(async () => {
        const lines = await page.locator(".xterm-rows > div").allTextContents();
        return lines.some((line) => line.trim() === marker) && !/Working|esc to interrupt/iu.test(lines.join("\n"));
      }, { timeout: 120_000 }).toBe(true);
      console.log(`${marker}: response completed`);
    };
    // 固定時間の待機ではなく、各ブラウザ描画フレームで位置を観測する。
    const sampleFrames = async (count: number): Promise<void> => {
      await page.evaluate((frames) => new Promise<void>((done) => {
        const next = (): void => {
          frames -= 1;
          if (frames === 0) done();
          else window.requestAnimationFrame(next);
        };
        window.requestAnimationFrame(next);
      }), count);
    };

    console.log("Turn 1: creating real conversation history");
    await sendPrompt(45, "FIRST_ANSWER_COMPLETE");
    await waitForAnswer("FIRST_ANSWER_COMPLETE");

    const reports: unknown[] = [];
    for (const turn of [2, 3]) {
      const prefix = `DRAFT_${turn}_`;
      const marker = `ANSWER_${turn}_COMPLETE`;
      const committed = "日本語入力確認";
      console.log(`Turn ${turn}: typing while Codex responds`);
      await sendPrompt(120, marker);
      phase = `turn-${turn}`;
      await probe.evaluate((state, value) => {
        state.prefix = value;
        state.samples = [];
        state.chunksWhileComposing = 0;
        state.syncStarts = 0;
      }, prefix);
      await page.keyboard.type(prefix, { delay: 40 });
      await expect(rows).toContainText(prefix);
      const preedits = ["に", "にほ", "にほん", "にほんご", "日本語", "日本語入力", committed];
      for (const text of preedits) {
        await cdp.send("Input.imeSetComposition", {
          text, selectionStart: text.length, selectionEnd: text.length,
        });
        await sampleFrames(20);
      }
      await page.screenshot({ path: join(artifactDirectory, `turn-${turn}-composing.png`) });
      await cdp.send("Input.insertText", { text: committed });
      await expect(rows).toContainText(prefix + committed);
      await waitForAnswer(marker);
      await expect(rows).toContainText(prefix + committed);
      await page.screenshot({ path: join(artifactDirectory, `turn-${turn}-completed.png`) });
      const measurements = await probe.evaluate((state) => ({
        samples: state.samples,
        chunksWhileComposing: state.chunksWhileComposing,
        syncStarts: state.syncStarts,
      }));
      const active = measurements.samples.filter((sample) => sample.working && sample.composing);
      const jumps = active.filter((sample) => sample.offsetY !== null && Math.abs(sample.offsetY) > sample.lineHeight * 1.25);
      const report = {
        turn,
        ...measurements,
        activeCompositionFrames: active.length,
        positionJumps: jumps.length,
        blankFrames: measurements.samples.filter((sample) => sample.hidden || sample.textLength === 0).length,
        missingAnchorFrames: active.filter((sample) => !sample.anchorFound).length,
        draftPreserved: true,
      };
      reports.push(report);
      await writeFile(join(artifactDirectory, "live-report.json"), JSON.stringify({ executablePath, reports, errors }, null, 2), "utf8");
      console.log(JSON.stringify({
        turn, activeCompositionFrames: active.length, positionJumps: jumps.length,
        chunksWhileComposing: measurements.chunksWhileComposing, syncStarts: measurements.syncStarts,
        blankFrames: report.blankFrames, missingAnchorFrames: report.missingAnchorFrames,
      }));
      phase = "";
      await probe.evaluate((state) => { state.prefix = ""; });
      expect(active.length, "実際の処理中に変換を観測できたフレーム数").toBeGreaterThan(30);
      expect(measurements.chunksWhileComposing).toBeGreaterThan(0);
      expect(report.positionJumps).toBe(0);
      expect(report.blankFrames).toBe(0);
      expect(report.missingAnchorFrames).toBe(0);
      await page.keyboard.press("Control+U");
      await expect(rows).not.toContainText(prefix);
    }
    await probe.evaluate((state) => { state.running = false; });
    await cdp.send("Page.stopScreencast");
    await Promise.all(frameWrites);
    await writeFile(join(artifactDirectory, "frames.json"), JSON.stringify(frameMetadata), "utf8");
    expect(errors).toEqual([]);
    console.log(`Completed: ${frameCount} captured frames`);
  } finally {
    await page.screenshot({ path: join(artifactDirectory, "final-screen.png"), timeout: 5_000 }).catch(() => undefined);
    await writeFile(join(artifactDirectory, "final-screen.txt"), await page.locator(".xterm-rows").innerText().catch(() => ""), "utf8");
    await app.close();
  }
});
