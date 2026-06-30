// Offline delta hit-rate harness (committed, opt-in). Drop the real release
// `.blockmap` files into electron-app/.delta-blockmaps/ (git-ignored) and run
//   corepack pnpm -F @matricarmz/electron-app test blockmapDelta.measure
// to measure the actual delta ratio between each consecutive release on the
// REAL production engine. Recipe to fetch them:
//   gh release download v<X.Y.Z> --pattern "*.blockmap" -D electron-app/.delta-blockmaps
// With no blockmaps present (e.g. CI) the suite skips cleanly.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { formatDeltaReport, measureBlockmapDelta } from './blockmapDelta.js';

const DIR = fileURLToPath(new URL('../../../.delta-blockmaps', import.meta.url));
const VERSION_RE = /-(\d+)\.(\d+)\.(\d+)\.exe\.blockmap$/;

type Found = { version: string; key: number[]; path: string };

function discover(): Found[] {
  let names: string[];
  try {
    names = readdirSync(DIR);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const m = VERSION_RE.exec(name);
      if (!m) return null;
      return { version: `${m[1]}.${m[2]}.${m[3]}`, key: [Number(m[1]), Number(m[2]), Number(m[3])], path: `${DIR}/${name}` };
    })
    .filter((x): x is Found => x !== null)
    .sort((a, b) => a.key[0]! - b.key[0]! || a.key[1]! - b.key[1]! || a.key[2]! - b.key[2]!);
}

const found = discover();

describe.skipIf(found.length < 2)('measure delta on real consecutive releases', () => {
  for (let i = 1; i < found.length; i += 1) {
    const from = found[i - 1]!;
    const to = found[i]!;
    it(`${from.version} -> ${to.version}`, () => {
      const report = measureBlockmapDelta(readFileSync(from.path), readFileSync(to.path));
      console.log(`[delta] ${from.version} -> ${to.version}: ${formatDeltaReport(report)}`);
      expect(report.deltaBytes).toBeLessThanOrEqual(report.fullBytes);
      expect(report.reusedBytes + report.deltaBytes).toBe(report.fullBytes);
      expect(report.downloadRatio).toBeGreaterThanOrEqual(0);
      expect(report.downloadRatio).toBeLessThanOrEqual(1);
    });
  }
});
