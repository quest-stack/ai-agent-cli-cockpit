import assert from "node:assert/strict";
import test from "node:test";

import { isGpuCrash } from "../../src/shared/process-gone";

import type { ProcessGoneDetails } from "../../src/shared/process-gone";

const GPU_CRASH_REASONS: ProcessGoneDetails["reason"][] = [
  "abnormal-exit",
  "crashed",
  "killed",
  "oom",
];

test("GPU の異常終了はクラッシュと判定する", () => {
  for (const reason of GPU_CRASH_REASONS) {
    assert.equal(
      isGpuCrash({ exitCode: 1, reason, type: "GPU" }),
      true,
      reason,
    );
  }
});

test("GPU の正常終了はクラッシュと判定しない", () => {
  assert.equal(
    isGpuCrash({ exitCode: 0, reason: "clean-exit", type: "GPU" }),
    false,
  );
});

test("GPU 以外のプロセス終了はクラッシュと判定しない", () => {
  assert.equal(
    isGpuCrash({ exitCode: 1, reason: "crashed", type: "Utility" }),
    false,
  );
});

test("再描画では直らない終了理由は回復対象にしない", () => {
  // 起動そのものに失敗している場合、アトラスを作り直しても描けるように
  // ならない。無駄に画面を揺らさないよう、回復対象から外していることを
  // 固定する（ホワイトリストに足されると、この期待が壊れて気づける）。
  for (const reason of [
    "launch-failed",
    "integrity-failure",
    "memory-eviction",
  ] as const) {
    assert.equal(
      isGpuCrash({ exitCode: 1, reason, type: "GPU" }),
      false,
      reason,
    );
  }
});
