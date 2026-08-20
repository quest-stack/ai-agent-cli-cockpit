import assert from "node:assert/strict";
import test from "node:test";

import { shouldAvoidWebgl } from "../../src/shared/gpu-fallback";

const ADRENO_RENDERER =
  "ANGLE (Qualcomm, Qualcomm(R) Adreno(TM) X2-90 GPU (0x36334630) Direct3D11 vs_5_0 ps_5_0, D3D11)";

const OTHER_GPU_RENDERERS = [
  "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
];

test("実測した Qualcomm Adreno renderer は WebGL を避ける", () => {
  assert.equal(shouldAvoidWebgl(ADRENO_RENDERER), true);
});

test("対象外 GPU の renderer は WebGL を避けない", () => {
  for (const renderer of OTHER_GPU_RENDERERS) {
    assert.equal(shouldAvoidWebgl(renderer), false, renderer);
  }
});

test("Adreno の大文字小文字を区別せず判定する", () => {
  assert.equal(shouldAvoidWebgl("adreno"), true);
  assert.equal(shouldAvoidWebgl("ADRENO"), true);
});

test("null は判定不能として WebGL を避けない", () => {
  assert.equal(shouldAvoidWebgl(null), false);
});

test("undefined は判定不能として WebGL を避けない", () => {
  assert.equal(shouldAvoidWebgl(undefined), false);
});

test("空文字は判定不能として WebGL を避けない", () => {
  assert.equal(shouldAvoidWebgl(""), false);
});
