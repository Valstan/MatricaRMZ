import { describe, expect, it } from 'vitest';

import { parseCalver } from './calver.js';
import { RELEASE_WELCOME_HISTORY, buildReleaseWelcomeDigest, type ReleaseWelcomeContent } from './releaseWelcome.js';

// Тесты держатся за свойства окна, а не за конкретные записи истории: список релизов
// растёт с каждым выпуском, и ассерты вида «ровно 4 записи» ломались бы каждый раз.

// Зеркало releaseDayMs из releaseWelcome.ts: у новой нумерации дату несёт releaseDate,
// у CalVer — сам номер.
function dayOf(release: Pick<ReleaseWelcomeContent, 'releaseLabel' | 'releaseDate'>): number | null {
  const m = String(release.releaseDate ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const p = parseCalver(release.releaseLabel);
  return p ? new Date(p.year, p.month - 1, p.day).getTime() : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const newest = RELEASE_WELCOME_HISTORY[0]!;

describe('buildReleaseWelcomeDigest', () => {
  it('подробную прозу не отдаёт — только список и подсказку', () => {
    const digest = buildReleaseWelcomeDigest(newest.releaseLabel);
    expect(digest.intro).toBeUndefined();
    expect(digest.highlights.length).toBeGreaterThan(0);
    expect(digest.outro).toBe(newest.outro);
    expect(digest.releaseLabel).toBe(newest.releaseLabel);
  });

  it('берёт новинки установленной версии и всех релизов за окно в 2 дня', () => {
    const anchorDay = dayOf(newest)!;
    const digest = buildReleaseWelcomeDigest(newest.releaseLabel);

    for (const h of newest.highlights) expect(digest.highlights).toContain(h);

    // Ни одной строки из релиза старше вчерашнего.
    const allowed = new Set(
      RELEASE_WELCOME_HISTORY.filter((r) => {
        const d = dayOf(r);
        return d != null && d >= anchorDay - DAY_MS && d <= anchorDay;
      }).flatMap((r) => r.highlights),
    );
    for (const h of digest.highlights) expect(allowed.has(h)).toBe(true);
  });

  it('окно в 1 день — только релизы того же дня', () => {
    const anchorDay = dayOf(newest)!;
    const sameDay = new Set(
      RELEASE_WELCOME_HISTORY.filter((r) => dayOf(r) === anchorDay).flatMap((r) => r.highlights),
    );
    const digest = buildReleaseWelcomeDigest(newest.releaseLabel, 1);
    for (const h of digest.highlights) expect(sameDay.has(h)).toBe(true);
  });

  it('клиент на старой версии не видит новинок, вышедших позже него', () => {
    const older = RELEASE_WELCOME_HISTORY.find(
      (r) => parseCalver(r.releaseLabel) && r.releaseLabel !== newest.releaseLabel,
    )!;
    const digest = buildReleaseWelcomeDigest(older.releaseLabel);
    expect(digest.releaseLabel).toBe(older.releaseLabel);
    for (const h of newest.highlights) {
      if (!older.highlights.includes(h)) expect(digest.highlights).not.toContain(h);
    }
  });

  it('неизвестная версия — падаем на самый свежий релиз', () => {
    const digest = buildReleaseWelcomeDigest('2099.101.0');
    expect(digest.releaseLabel).toBe(newest.releaseLabel);
  });

  it('запись без даты (старые 1.x без releaseDate) — показываем только её', () => {
    const legacy = RELEASE_WELCOME_HISTORY.find((r) => dayOf(r) == null);
    if (!legacy) return;
    const digest = buildReleaseWelcomeDigest(legacy.releaseLabel);
    expect(digest.releaseLabel).toBe(legacy.releaseLabel);
    expect(digest.highlights).toEqual(legacy.highlights);
  });
});
