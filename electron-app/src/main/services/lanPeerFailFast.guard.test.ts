import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Раздача между машинами включается по машинам: сначала правило брандмауэра, потом тумблер.
// Пока правила нет, сосед зарегистрирован пиром, но его порт молча роняет SYN. С общим порогом
// (45 с тишины × 2 попытки) каждый такой сосед стоил бы минуты ожидания до обращения к серверу.
// Сторож держит то, что ломается молча: обновление «работает», просто приходит на минуты позже.
const SRC = readFileSync(fileURLToPath(new URL('./updateService.ts', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);

function constant(name: string): number {
  const m = SRC.match(new RegExp(`export const ${name} = ([0-9_]+);`));
  if (!m) throw new Error(`${name} not found in updateService.ts`);
  return Number(m[1].replace(/_/g, ''));
}

describe('глухой сосед по локальной сети не держит обновление', () => {
  it('соседу даётся одна попытка', () => {
    expect(constant('LAN_PEER_DOWNLOAD_ATTEMPTS')).toBe(1);
  });

  it('окно тишины соседа — секунды, а не общий порог', () => {
    const lan = constant('LAN_PEER_NO_PROGRESS_MS');
    expect(lan).toBeGreaterThanOrEqual(5_000);
    expect(lan).toBeLessThanOrEqual(10_000);
  });

  it('короткие пороги применяются к соседям, а серверный webseed остаётся на общих', () => {
    const body = SRC.slice(SRC.indexOf('async function tryDownloadFromTorrentPeers('));
    const loop = body.slice(0, body.indexOf("return { ok: false as const, error: 'torrent peer download failed' }"));
    expect(loop).toContain('const isLanPeer = url !== serverWebSeedUrl;');
    expect(loop).toContain('attempts: isLanPeer ? LAN_PEER_DOWNLOAD_ATTEMPTS : 2,');
    expect(loop).toContain('noProgressTimeoutMs: isLanPeer ? LAN_PEER_NO_PROGRESS_MS : UPDATE_DOWNLOAD_NO_PROGRESS_MS,');
  });
});
