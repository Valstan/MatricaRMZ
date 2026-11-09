// Сторож плашки «Утиль» на карточке двигателя.
//
// Правило владельца (09.11.2026): утильный двигатель должен читаться СРАЗУ и ВЕЗДЕ —
// «прямо как прокаженный на розовом фоне». В списках это розовая строка, в карточке
// двигателя строки нет — значит, нужна плашка в шапке. Проверяем, что плашка есть,
// берёт цвет из общего правила и считает утиль по общему признаку.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const BADGE = read('./EngineScrapBadge.tsx');
const CARD_PAGE = read('../pages/EngineDetailsPage.tsx');
const RULE = read('../../../../../../shared/src/domain/engineScrap.ts');

describe('плашка «Утиль» на карточке двигателя', () => {
  it('плашка есть и стоит в шапке карточки', () => {
    expect(BADGE).toContain('data-engine-scrap-badge');
    expect(CARD_PAGE).toContain('<EngineScrapBadge');
    // Шапка карточки — это слот status оболочки EntityCardShell.
    expect(CARD_PAGE).toContain('status={');
  });

  it('цвет и подпись берутся из общего правила, а не копируются', () => {
    expect(BADGE).toContain('ENGINE_SCRAP_BADGE_BACKGROUND');
    expect(BADGE).toContain('ENGINE_SCRAP_BADGE_COLOR');
    expect(BADGE).toContain('ENGINE_SCRAP_BADGE_LABEL');
    expect(BADGE).not.toContain('rgba(239, 68, 68');
    expect(RULE).toContain('ENGINE_SCRAP_BADGE_LABEL');
    expect(RULE).toContain('ENGINE_SCRAP_BADGE_BACKGROUND');
  });

  it('утиль считается по общему признаку (isScrapEngine), а не «на глаз»', () => {
    expect(CARD_PAGE).toContain('isScrapEngine(statusFlags)');
    expect(CARD_PAGE).not.toContain('props.engine.isScrap');
  });
});
