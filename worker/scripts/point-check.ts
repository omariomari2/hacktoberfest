/** Validates the smoke fixture's screen1 pixel target. */
export function verifyPoint(text: string, target: { left: number; top: number; right: number; bottom: number }): boolean {
  const matches = [...text.matchAll(/\[POINT:(\d+),(\d+):[^:\]]+:screen(\d+)\]/g)];
  return matches.length > 0 && matches.every((match) => {
    const x = Number(match[1]);
    const y = Number(match[2]);
    return match[3] === "1" && x >= target.left && x < target.right && y >= target.top && y < target.bottom;
  });
}
