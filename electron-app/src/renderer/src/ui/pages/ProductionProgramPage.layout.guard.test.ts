import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Экран производственных программ после промта КАРМАНА #179: плашки по
// свежести правки, открытая программа — на весь экран, плашки при этом сжаты
// в вертикальные полоски с периодом.
//
// Сторож по тексту страницы — как и остальные сторожи этого экрана: проверять
// надо именно ПОРЯДОК и НАЛИЧИЕ (иначе правка тихо вернёт «плашки как приехали
// из реплики» или «программа снова занимает половину экрана»).
//
// Сами правила проверяются числами в `utils/productionProgramLayout.test.ts` —
// здесь проверяется, что страница берёт ИХ, а не пишет свои.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./ProductionProgramPage.tsx');

describe('производственная программа — порядок плашек и раскладка (#179)', () => {
  it('плашки сортируются по свежести правки, а не «как приехали из реплики»', () => {
    expect(PAGE, 'плашки должны идти через правило свежести').toContain(
      'sortProductionProgramsByFreshness(allPrograms',
    );
    // Сырой список в разметку попадать не должен: это и есть «случайный порядок».
    expect(PAGE, 'на экран выводится несортированный список программ').not.toContain('allPrograms.map');
    expect(PAGE, 'плашки перечисляются отсортированным списком').toContain('programs.map');
  });

  it('программа с несохранённой правкой берёт время с клиента', () => {
    // Серверное время программы до прихода зеркала старое — без клиентской
    // метки свежая правка осталась бы внизу списка.
    expect(PAGE, 'нужна клиентская метка правки').toContain('setLocalEdits(');
    expect(PAGE, 'метка ставится вместе с пометкой «не сохранена»').toContain('markUnsaved');
  });

  it('открытая программа занимает максимум экрана', () => {
    expect(PAGE, 'раскладку собирает правило, а не страница руками').toContain('productionProgramLayout(');
    expect(PAGE, 'ширины колонок берутся из раскладки').toContain(
      'gridTemplateColumns: `${layout.listColumn} ${layout.programColumn}`',
    );
    // Старая раскладка — программа на половине экрана.
    expect(PAGE, 'вернулась половинная раскладка экрана').not.toContain(
      "gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)'",
    );
  });

  it('при открытой программе плашки сжаты в вертикальные полоски с периодом', () => {
    expect(PAGE, 'нет вертикальной надписи на полоске').toContain("writingMode: 'vertical-rl'");
    expect(PAGE, 'надпись полоски не содержит периода').toContain('productionProgramStripLabel(');
    expect(PAGE, 'полоска не помечена как полоска').toContain('data-pp-tile="strip"');
  });

  it('есть кнопка возврата к списку программ, и плашки при этом видны', () => {
    expect(PAGE, 'нет кнопки возврата к списку').toContain('data-pp-action="back-to-list"');
    expect(PAGE, 'возврат не говорит, куда возвращает').toContain('Вернуться к списку производственных программ');
    // Плашки остаются на экране: рельс рисуется всегда, а не только в списке.
    expect(PAGE, 'плашки пропадают при открытой программе').toContain('renderProgramStrip(p)');
  });

  it('возврат к списку не съедает несохранённую правку', () => {
    expect(PAGE, 'возврат должен отправить отложенную правку на сервер').toContain('flushPendingSaves();');
    expect(PAGE, 'программа при возврате остаётся выбранной').toContain('setListMode(true);');
  });

  it('есть переключатель «развернуть/свернуть список», и он переживает открытие программы', () => {
    expect(PAGE, 'нет переключателя списка').toContain('data-pp-action="toggle-list"');
    expect(PAGE, 'переключатель не говорит, что делает').toContain('Развернуть список');
    expect(PAGE, 'выбор оператора должен переживать открытие программы').toContain('listExpanded');
  });

  it('вверху программы — полное название и период крупной строкой', () => {
    expect(PAGE, 'нет крупного названия программы').toContain('data-pp-program-title="true"');
    expect(PAGE, 'нет крупной строки периода').toContain('data-pp-program-period="true"');
    expect(PAGE, 'в шапке нет периода с обеими датами').toContain('productionProgramPeriodLine(');
  });

  it('сводка выполнения, цвет статуса и кнопки плана остались на месте', () => {
    expect(PAGE, 'пропала сводка выполнения на плашке').toContain('Собрано');
    expect(PAGE, 'пропал цвет статуса').toContain('PROGRAM_STATUS_TONES');
    expect(PAGE, 'пропала кнопка «Добавить списком»').toContain('Добавить списком');
    expect(PAGE, 'пропала кнопка сохранения').toContain('data-pp-action="save"');
    expect(PAGE, 'пропала печать').toContain('data-pp-action="print"');
    expect(PAGE, 'пропала выгрузка в Word').toContain('data-pp-action="word"');
    expect(PAGE, 'пропала выгрузка в Excel').toContain('data-pp-action="excel"');
    expect(PAGE, 'пропал выбор программы из списка').toContain('selectProgram(p.id)');
  });
});
