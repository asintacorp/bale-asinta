/** Chunks an array into groups of `size` (used for 3×3 = 9 slips per A4 page). */
export function chunkBy<T>(arr: T[], size: number): T[][] {
  return arr.reduce<T[][]>((acc, _, i) => (i % size === 0 ? [...acc, arr.slice(i, i + size)] : acc), []);
}
