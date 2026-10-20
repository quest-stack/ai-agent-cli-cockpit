export interface ChangeRegion { x: number; y: number; width: number; height: number }

/** Group changed RGBA pixels into nearby regions; small color noise is ignored. */
export function visualChanges(before: Uint8ClampedArray, after: Uint8ClampedArray, width: number, height: number, ignoredTop = 0): ChangeRegion[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 2560000
    || !Number.isInteger(ignoredTop) || ignoredTop < 0 || ignoredTop > height || before.length !== width * height * 4 || after.length !== before.length) throw new Error("Invalid image dimensions");
  const step = 16; const columns = Math.ceil(width / step); const rows = Math.ceil(height / step);
  const changed = new Uint16Array(columns * rows);
  for (let y = ignoredTop; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    if (Math.max(Math.abs(before[offset] - after[offset]), Math.abs(before[offset + 1] - after[offset + 1]),
      Math.abs(before[offset + 2] - after[offset + 2]), Math.abs(before[offset + 3] - after[offset + 3])) > 24) changed[Math.floor(y / step) * columns + Math.floor(x / step)]++;
  }
  const regions: ChangeRegion[] = [];
  const visited = new Uint8Array(changed.length);
  for (let index = 0; index < changed.length; index++) {
    if (visited[index] || changed[index] < 2) continue;
    const queue = [index]; visited[index] = 1;
    let minX = columns; let maxX = 0; let minY = rows; let maxY = 0;
    for (let next = 0; next < queue.length; next++) {
      const current = queue[next]; const x = current % columns; const y = Math.floor(current / columns);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx; const ny = y + dy; const neighbor = ny * columns + nx;
        if (nx >= 0 && nx < columns && ny >= 0 && ny < rows && !visited[neighbor] && changed[neighbor] >= 2) { visited[neighbor] = 1; queue.push(neighbor); }
      }
    }
    regions.push({ x: minX * step, y: minY * step, width: Math.min(width, (maxX + 1) * step) - minX * step, height: Math.min(height, (maxY + 1) * step) - minY * step });
  }
  if (regions.length <= 100) return regions;
  const x = Math.min(...regions.map((region) => region.x)); const y = Math.min(...regions.map((region) => region.y));
  return [{ x, y, width: Math.max(...regions.map((region) => region.x + region.width)) - x, height: Math.max(...regions.map((region) => region.y + region.height)) - y }];
}
