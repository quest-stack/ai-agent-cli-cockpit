/**
 * ARM64 Windows でも x64 ビルドでは process.arch が "x64" になるため、
 * アーキテクチャではなく実際の GPU renderer 文字列で判定する。
 */
export function shouldAvoidWebgl(
  rendererString: string | null | undefined,
): boolean {
  if (!rendererString) {
    // 判定不能を理由に全環境の描画品質を落とさないよう、WebGL を使う側へ倒す。
    return false;
  }

  const normalizedRenderer = rendererString.toLowerCase();
  return (
    normalizedRenderer.includes("adreno") ||
    normalizedRenderer.includes("qualcomm")
  );
}
