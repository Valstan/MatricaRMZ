import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Переверстка модуля ПП (владелец 10.11.2026). Требования заказчика — «ширину на всю
// программу», «слева плашки программ, справа настройка открытой», «порядок полей:
// название → цех → период → статус», «поиск в выпадашках договоров и двигателей».
//
// Сторож по тексту, а не рендером: экран собирается из таблиц и компонентов, а проверять
// надо именно ПОРЯДОК и НАЛИЧИЕ (иначе следующая правка тихо вернёт «три поля дат
// наползли на название»).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./ProductionProgramPage.tsx');
const PREVIEW = src('../components/ProductionProgramPrintPreview.tsx');
const PRINT_HTML = src('../utils/productionProgramPrintHtml.ts');
const CSS = src('../global.css');
const SHARED_DOMAIN = src('../../../../../../shared/src/domain/productionProgram.ts');

describe('производственная программа — экран после переверстки', () => {
  it('модуль во всю ширину области контента', () => {
    // Без этого карточка ПП упиралась в общий потолок 1400px, а её секция — в 1200px.
    expect(PAGE).toContain('production-program-page');
    expect(CSS).toContain('.ui-content-viewport > .production-program-page');
    expect(CSS).toContain('--ui-content-block-max-width: 100%');
  });

  it('экран разделён на две части: слева плашки программ, справа настройка открытой', () => {
    expect(PAGE).toContain('Производственные программы');
    expect(PAGE).toContain('Строки плана');
    // Слева — плашки с датой и статусом, справа — редактор.
    expect(PAGE).toContain('formatProductionProgramPeriod');
    expect(PAGE).toContain('PROGRAM_STATUS_TONES');
  });

  it('порядок полей шапки: название → цех → период → статус', () => {
    // Заказ владельца дословно: «сперва название, потом выбор цеха, потом период,
    // потом статус программы». Порядок закреплён текстом — иначе он снова разъедется.
    const order = ['Название программы', 'Цех', 'Период', 'Период с', 'Период по', 'Статус программы'];
    const positions = order.map((label) => PAGE.indexOf(`'${label}'`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it('период выбирается: вид периода и календарь в обе даты', () => {
    expect(PAGE).toContain('PRODUCTION_PROGRAM_PERIOD_LABELS');
    expect(PAGE).toContain('UnifiedDateInput');
    expect(PAGE).toContain("'Период с'");
    expect(PAGE).toContain("'Период по'");
  });

  it('поиск в выпадашках договоров и двигателей — тот же механизм, что в списках', () => {
    expect(PAGE).toContain('SearchSelect');
    expect(PAGE).toContain("'Договор'");
    expect(PAGE).toContain("'Двигатель'");
  });

  it('выбор двигателя подтягивает договор из карточки (поиски взаимозаменяемы)', () => {
    expect(PAGE).toContain('engine?.contractId');
  });

  it('«Организация» — живая подпись из карточки: заказчик и три цифры договора', () => {
    expect(PAGE).toContain('productionProgramOrganizationLabel');
    expect(SHARED_DOMAIN).toContain('shortContractSuffix');
  });

  it('строки плана сгруппированы по договорам', () => {
    expect(PAGE).toContain('groups');
    expect(PAGE).toContain('contractLabelById');
  });

  it('статус программы различается цветом плашки', () => {
    expect(PAGE).toContain("draft: { bg: '#f1f5f9'");
    expect(PAGE).toContain("approved: { bg: '#dcfce7'");
  });

  it('id строки плана — постоянный (черновой id ронял строку при сохранении)', () => {
    expect(PAGE).toContain('crypto.randomUUID()');
    // Черновой id собирался шаблонной строкой — именно её и не должно остаться.
    expect(PAGE).not.toContain('draft-${');
  });

  it('план следит за выполнением сам: счётчики на плашке и отметка в строке', () => {
    // Владелец (10.11.2026): «план сам себя отслеживал, выполнение плана по статусам
    // двигателей… показывать, сколько двигателей ещё не собраны, невыполнены, сколько
    // выполнены».
    expect(PAGE).toContain('productionProgramExecutionSummary');
    expect(PAGE).toContain('productionProgramRowExecution');
    expect(PAGE).toContain('Собрано');
    expect(PAGE).toContain('Просрочено');
    expect(PAGE).toContain('<th>Выполнение</th>');
    expect(SHARED_DOMAIN).toContain('export function productionProgramExecutionSummary');
    expect(SHARED_DOMAIN).toContain('export function productionProgramRowExecution');
  });

  it('«Печать» открывает превью, а не сразу принтер', () => {
    // Владелец (10.11.2026): «нужен промежуточный этап, чтобы можно было редактировать
    // форму печати галочками… при нажатии кнопки Печать сперва показывать превью».
    expect(PAGE).toContain('ProductionProgramPrintPreview');
    // Прямая печать мимо превью — значит, оператор снова увидит только окно принтера.
    expect(PAGE).not.toContain('openProductionProgramPrint');
    expect(PREVIEW).toContain('data-pp-print-preview');
    expect(PREVIEW).toContain('type="checkbox"');
    expect(PREVIEW).toContain('Подписи');
    expect(PREVIEW).toContain('Размеры шрифта');
    // Печатная форма умеет настраиваться: кегли и состав подписей.
    expect(PRINT_HTML).toContain('signatureCaptions');
    expect(PRINT_HTML).toContain('signatureFontSize');
    expect(PRINT_HTML).toContain('tableFontSize');
  });
});
