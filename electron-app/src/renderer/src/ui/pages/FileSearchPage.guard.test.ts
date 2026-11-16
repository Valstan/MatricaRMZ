/**
 * Сторож модуля «Поиск по файлам».
 *
 * Три правила, которые легко сломать правкой страницы и которые потом стоят
 * оператору дорого:
 * 1. Файлы читает главный процесс. В renderer не должно быть ни `exceljs`,
 *    ни `jszip`, ни доступа к диску — иначе страница станет мостом «прочитай
 *    любой файл с диска» (прецедент — `filesReadPastableText`).
 * 2. Модуль только читает: в выбранные файлы не пишет ничего.
 * 3. Запись в карточку идёт через единственную дверь `engines:card:save`
 *    (с гейтами дублей и авто-этапами). Второй вход разошёлся бы с ней —
 *    класс brain G363.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { matchPrefixRule } from '../../../../main/ipc/sectionGate.js';

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('../pages/FileSearchPage.tsx');
const APP = src('../App.tsx');
const SECTIONS = src('../../../../../../shared/src/domain/uiSections.ts');

describe('модуль «Поиск по файлам»: сторож формы', () => {
  it('файлы читает главный процесс — в renderer нет ни сборщиков, ни диска', () => {
    expect(PAGE).not.toMatch(/from 'exceljs'/);
    expect(PAGE).not.toMatch(/from 'jszip'/);
    expect(PAGE).not.toMatch(/node:fs/);
    expect(PAGE).not.toMatch(/readFileSync|writeFileSync/);
  });

  it('модуль не пишет в выбранные файлы', () => {
    expect(PAGE).not.toMatch(/writeFile|createWriteStream|showSaveDialog/);
  });

  it('запись в карточку идёт через единственную дверь engines:card:save', () => {
    expect(PAGE).toContain('window.matrica.engines.card.save');
    expect(PAGE).not.toContain('engines.setAttr');
  });

  it('перед переносом показывается предпросмотр «что → куда»', () => {
    expect(PAGE).toContain('buildEngineCardTransferPreview');
    expect(PAGE).toContain('Что будет скопировано');
  });

  it('недоступный файл виден оператору с полным путём', () => {
    expect(PAGE).toContain('item.path');
    expect(PAGE).toContain('Файлы, которые не прочитались');
  });

  it('раздел зарегистрирован: вкладка, подпись и меню', () => {
    expect(APP).toContain("t === 'file_search'");
    expect(APP).toContain("['file_search'] as const");
    expect(SECTIONS).toContain("file_search: 'Поиск по файлам'");
  });

  it('каналы модуля гейтятся разделом «Производство»', () => {
    expect(matchPrefixRule('fileSearch:pick')).toBe('production');
    expect(matchPrefixRule('fileSearch:search')).toBe('production');
    expect(matchPrefixRule('fileSearch:context')).toBe('production');
    expect(matchPrefixRule('fileSearch:resolveLabels')).toBe('production');
  });

  // Правка 16.11.2026: оператор увидел в карточке uuid вместо номера договора и
  // не смог понять, где данные разошлись с файлом. Обе вещи легко теряются
  // молча: типы и линт останутся зелёными.
  it('ссылки карточки расшифровываются в названия, а не показываются как id', () => {
    expect(PAGE).toContain('resolveLabels');
    expect(PAGE).toContain('UUID_RE');
  });

  it('найденное сверяется с карточкой: видно, что совпало, что разошлось и что переносить', () => {
    expect(PAGE).toContain('compareFindingsWithCard');
    expect(PAGE).toContain('Сверка с файлами');
    expect(PAGE).toContain('Расходится');
  });

  it('находки лежат списком «подпись — значение», а не squeezed-таблицей', () => {
    expect(PAGE).toContain('renderFindingRow');
    expect(PAGE).not.toContain('<th key={`${header}-${i}`}>');
  });
});
