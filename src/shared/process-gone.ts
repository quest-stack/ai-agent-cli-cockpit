export interface ProcessGoneDetails {
  exitCode: number;
  reason:
    | "clean-exit"
    | "abnormal-exit"
    | "killed"
    | "crashed"
    | "oom"
    | "launch-failed"
    | "integrity-failure"
    | "memory-eviction";
  type:
    | "Utility"
    | "Zygote"
    | "Sandbox helper"
    | "GPU"
    | "Pepper Plugin"
    | "Pepper Plugin Broker"
    | "Unknown";
}

// GPU の正常終了や、再描画では直らない起動失敗まで回復対象にしないため、
// テクスチャ消失につながり得る異常終了理由だけを明示する。
const GPU_CRASH_REASONS = new Set<ProcessGoneDetails["reason"]>([
  "abnormal-exit",
  "crashed",
  "killed",
  "oom",
]);

export function isGpuCrash(details: ProcessGoneDetails): boolean {
  return details.type === "GPU" && GPU_CRASH_REASONS.has(details.reason);
}
