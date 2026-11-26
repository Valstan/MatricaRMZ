import { describe, expect, it } from 'vitest';

import { compareAppVersion } from './appVersion.js';
import { parseCalver } from './calver.js';
import {
  RELEASE_WELCOME_COMPACT_FROM,
  RELEASE_WELCOME_HIGHLIGHT_MAX_CHARS,
  RELEASE_WELCOME_HISTORY,
  RELEASE_WELCOME_VARIANTS,
  buildReleaseWelcomeDigest,
  parseReleaseWelcomeLine,
  pickReleaseWelcomeVariant,
  type ReleaseWelcomeContent,
} from './releaseWelcome.js';

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

describe('выбор оформления окна (промт КАРМАНА #162)', () => {
  it('все три варианта живут в программе', () => {
    expect([...RELEASE_WELCOME_VARIANTS]).toEqual(['aurora', 'vines', 'snow']);
  });

  it('одна машина в рамках одного обновления получает одно оформление', () => {
    const variant = pickReleaseWelcomeVariant('pc79-11111111-2222-3333-4444-555555555555', '3.148.0');
    expect(RELEASE_WELCOME_VARIANTS).toContain(variant);
    for (let i = 0; i < 5; i++) {
      expect(pickReleaseWelcomeVariant('pc79-11111111-2222-3333-4444-555555555555', '3.148.0')).toBe(variant);
    }
  });

  it('разные машины получают разные оформления', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      seen.add(pickReleaseWelcomeVariant(`pc${i}-11111111-2222-3333-4444-555555555555`, '3.148.0'));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('другой релиз — другое оформление (выбор зависит от версии)', () => {
    const clientId = 'pc79-11111111-2222-3333-4444-555555555555';
    const versions = ['3.148.0', '3.149.0', '3.150.0', '3.151.0'];
    const variants = new Set(versions.map((v) => pickReleaseWelcomeVariant(clientId, v)));
    expect(variants.size).toBeGreaterThan(1);
  });

  it('пустая идентичность машины не ломает выбор', () => {
    expect(RELEASE_WELCOME_VARIANTS).toContain(pickReleaseWelcomeVariant('', '3.148.0'));
  });
});

describe('разбор строки новинки', () => {
  it('зачин уходит в жирный, символов * в тексте не остаётся', () => {
    const line = parseReleaseWelcomeLine('✦ **Списки ведут себя одинаково.** В каждом списке одни правила.');
    expect(line.marker).toBe('✦');
    expect(line.lead).toBe('Списки ведут себя одинаково.');
    expect(line.rest).toBe('В каждом списке одни правила.');
    expect([line.marker, line.lead, line.rest].join(' ')).not.toContain('*');
  });

  it('строка без зачина остаётся обычным текстом', () => {
    const line = parseReleaseWelcomeLine('Где искать: в любом списке программы.');
    expect(line.lead).toBe('');
    expect(line.rest).toBe('Где искать: в любом списке программы.');
  });

  it('переносы строк внутри строки не ломают разбор', () => {
    const line = parseReleaseWelcomeLine('✦ **Зачин.**\nВторая строка.');
    expect(line.lead).toBe('Зачин.');
    expect(line.rest).toBe('Вторая строка.');
  });
});

describe('правило компактного текста (промт КАРМАНА #162)', () => {
  /** Нарушения правила: длинная строка, нет жирного зачина, в видимом тексте остались `*`. */
  function violations(line: string): string[] {
    const problems: string[] = [];
    const parsed = parseReleaseWelcomeLine(line);
    if (!parsed.lead) problems.push('нет жирного зачина');
    if (parsed.marker.length > 0 && parsed.lead.length === 0) problems.push('маркер без зачина');
    // `**` — это разметка исходника; в окне её видеть не должно.
    if ([parsed.marker, parsed.lead, parsed.rest].join(' ').includes('*')) {
      problems.push('в видимом тексте остались символы *');
    }
    if (line.length > RELEASE_WELCOME_HIGHLIGHT_MAX_CHARS) {
      problems.push(`строка длиннее ${RELEASE_WELCOME_HIGHLIGHT_MAX_CHARS} знаков (${line.length})`);
    }
    return problems;
  }

  it('записи новой эпохи (с 3.148.0) записаны по правилу', () => {
    for (const release of RELEASE_WELCOME_HISTORY) {
      if (compareAppVersion(release.releaseLabel, RELEASE_WELCOME_COMPACT_FROM) < 0) continue;
      for (const line of release.highlights) {
        expect(violations(line), `${release.releaseLabel}: ${line}`).toEqual([]);
      }
    }
  });

  it('образец строки, записанной по правилу, проходит проверку', () => {
    const sample = '✦ **Печать картинок из выдачи.** Теперь печать ищет принтер сама.';
    expect(violations(sample)).toEqual([]);
    expect(sample.length).toBeLessThanOrEqual(RELEASE_WELCOME_HIGHLIGHT_MAX_CHARS);
  });
});
