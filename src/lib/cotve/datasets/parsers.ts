/**
 * Parsers for the REAL dataset formats, verified from official sources:
 *  - IDD detection: Pascal-VOC-like XML (`<object><name>…</name>…`).
 *  - CityFlowV2 tracking lines: officially documented only for the SUBMISSION
 *    format (9 fields: cam obj frame x y w h xworld yworld); the released
 *    ground truth may differ, so 6–9 numeric fields are accepted and the
 *    observed schema is reported by the caller. Nothing is invented here.
 */

export function countVocClasses(xml: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of xml.matchAll(/<object>[\s\S]*?<name>\s*([^<\s]+)\s*<\/name>[\s\S]*?<\/object>/g)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return counts;
}

export interface CityFlowLine {
  /** present when the line carries the camera id (submission schema) */
  camId: string | null;
  objId: string;
  frameId: number;
  xmin: number;
  ymin: number;
  width: number;
  height: number;
  /** world coords, when present (not used in evaluation per official docs) */
  world: [number, number] | null;
}

export function parseCityFlowLine(line: string): { ok: true; value: CityFlowLine } | { ok: false; error: string } {
  const f = line.trim().split(/\s+/);
  if (f.length < 6 || f.length > 9) {
    return { ok: false, error: `malformed GT line (${f.length} fields, expected 6–9): "${line.slice(0, 60)}"` };
  }
  const nums: number[] = [];
  for (let i = 1; i < f.length; i++) {
    const n = Number(f[i]);
    if (!Number.isFinite(n)) {
      return { ok: false, error: `non-numeric field ${i}: "${f[i]}"` };
    }
    nums.push(n);
  }
  const has9 = f.length === 9;
  // 9-field submission schema: cam obj frame x y w h xworld yworld
  // 6-field GT variant:        obj frame x y w h
  const off = has9 ? 1 : 0;
  return {
    ok: true,
    value: {
      camId: has9 ? f[0] : null,
      objId: f[off],
      frameId: nums[off],
      xmin: nums[off + 1],
      ymin: nums[off + 2],
      width: nums[off + 3],
      height: nums[off + 4],
      world: has9 ? [nums[off + 5], nums[off + 6]] : null,
    },
  };
}
