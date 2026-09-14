import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Кэш вложений на боксе снят намеренно (решение владельца 14.09): клиент качает прямо с
 * Я.Диска. Вернуть его назад легко и незаметно — достаточно одной строки «положим копию, вдруг
 * пригодится», и диск снова начнёт наполняться по полтора гигабайта за день фотографий. Причём
 * заметят это не тесты, а кончившееся место на проде.
 */
const SRC = readFileSync(fileURLToPath(new URL('./files.ts', import.meta.url)), 'utf8');

describe('на боксе не заводится кэш вложений', () => {
  it('отдача файла с Я.Диска не кладёт копию на диск', () => {
    const fn = SRC.slice(SRC.indexOf('async function sendYandexFile'), SRC.indexOf("filesRouter.get('/:id',"));
    expect(fn, 'прогрев кэша вернулся в отдачу').not.toContain('writeBytes(');
    expect(fn).not.toContain('localCachedAt');
  });

  it('загрузка снимает временную копию, как только Я.Диск подтвердил свою', () => {
    expect(SRC).toContain('if (diskPath) await unlinkAsync(join(uploadsDir(), rel)).catch(() => {});');
    // Строка получает локальный путь ТОЛЬКО когда копия на боксе единственная.
    expect(SRC).toContain('localRelPath: diskPath ? null : rel,');
  });

  it('ссылка на прямое скачивание по-прежнему выдаётся', () => {
    // Без неё «кэш убрали» превращается в «каждый байт идёт через бокс дважды».
    expect(SRC).toContain("filesRouter.get('/:id/url'");
    expect(SRC).toContain('return res.json({ ok: true, url: href });');
  });

  it('превью остаются на боксе — их снимать не просили', () => {
    expect(SRC).toContain('previewLocalRelPath');
  });
});
