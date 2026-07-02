// Offline validation of the local blockmap generator against the REAL
// electron-builder output (committed, opt-in). Drop a release installer AND its
// blockmap into electron-app/.delta-blockmaps/ (git-ignored) and run
//   corepack pnpm -F @matricarmz/electron-app test blockmapDelta.generate
// Recipe:
//   gh release download v<X.Y.Z> --pattern "*.exe" -D electron-app/.delta-blockmaps
//   gh release download v<X.Y.Z> --pattern "*.blockmap" -D electron-app/.delta-blockmaps
// With no exe+blockmap pair present (e.g. CI) the suite skips cleanly.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { generateBlockmap, parseBlockmap, serializeBlockmap } from './blockmapDelta.js';

const DIR = fileURLToPath(new URL('../../../.delta-blockmaps', import.meta.url));

function discoverPairs(): Array<{ exe: string; blockmap: string }> {
  let names: string[];
  try {
    names = readdirSync(DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.toLowerCase().endsWith('.exe') && names.includes(`${n}.blockmap`))
    .map((n) => ({ exe: `${DIR}/${n}`, blockmap: `${DIR}/${n}.blockmap` }));
}

const pairs = discoverPairs();

describe.skipIf(pairs.length === 0)('generateBlockmap matches real electron-builder blockmap', () => {
  for (const pair of pairs) {
    it(pair.exe.split('/').pop()!, { timeout: 120_000 }, () => {
      const real = parseBlockmap(readFileSync(pair.blockmap));
      const generated = generateBlockmap(readFileSync(pair.exe));
      expect(generated.files[0]!.sizes).toEqual(real.files[0]!.sizes);
      expect(generated.files[0]!.checksums).toEqual(real.files[0]!.checksums);
      // Round-trip: сериализованный вид читается нашим же парсером.
      const reparsed = parseBlockmap(serializeBlockmap(generated));
      expect(reparsed.files[0]!.checksums.length).toBe(real.files[0]!.checksums.length);
    });
  }
});
