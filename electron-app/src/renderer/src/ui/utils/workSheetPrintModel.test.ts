import { describe, expect, it } from 'vitest';

import {
  HUMAN_LABEL_DASH,
  HUMAN_LABEL_NO_NUMBER,
  WORK_ORDER_APPROVERS,
  type WorkSheetColumn,
  type WorkSheetField,
  type WorkSheetRow,
} from '@matricarmz/shared';

import { buildWorkSheetPrintModel, type WorkSheetPrintDeps } from './workSheetPrintModel.js';

/**
 * Идентификаторы фикстуры нарочно в форме uuid: сторож п. «на бумагу не попадает» должен
 * ловить их так же, как поймал бы настоящие. Логин и номер двигателя вымышленные — репо публичный.
 */
const ROW_ID = '11111111-1111-4111-8111-111111111111';
const ENGINE_ID = '22222222-2222-4222-8222-222222222222';
const TYPE_ID = '33333333-3333-4333-8333-333333333333';
const WORKSHOP_ID = '44444444-4444-4444-8444-444444444444';
const TYPE_CODE = 'ukladka_vala';

/**
 * Полдень 15.09.2026 по МЕСТНОМУ времени. Дату строит `new Date(y, m, d)`, а не `Date.parse`
 * с зоной: бланк обязан печатать тот же день, что оператор набрал в карточке, на любой машине.
 */
const AT = new Date(2026, 8, 15, 12, 0, 0).getTime();

const HOURS_COLUMN: WorkSheetColumn = { code: 'hours', label: 'Часы обкатки', type: 'number' };

function field(over: Partial<WorkSheetField> = {}): WorkSheetField {
  return { code: 'hours', label: 'Часы обкатки', type: 'number', value: 12.5, ...over };
}

/** Поле колонки, которую из живого вида работ уже удалили: на экране его нет, в строке — есть. */
const REMOVED_FIELD: WorkSheetField = { code: 'old_note', label: 'Снятая колонка', type: 'text', value: 'записано' };

function row(over: Partial<WorkSheetRow> = {}): WorkSheetRow {
  return {
    id: ROW_ID,
    engineId: ENGINE_ID,
    engineNumber: 'TEST-001',
    engineBrand: 'TEST-BRAND',
    internalNumber: '77',
    customerName: 'Ромашка',
    customerFullName: 'ООО «Ромашка»',
    contractNumber: 'Д-2026/14',
    contractShortLabel: '14',
    at: AT,
    typeId: TYPE_ID,
    typeCode: TYPE_CODE,
    typeName: 'Укладка вала',
    workshopId: WORKSHOP_ID,
    workshopName: 'Цех из снимка',
    performedBy: 'oper',
    note: 'Без замечаний',
    fields: [field()],
    repairStamped: false,
    ...over,
  };
}

function deps(over: Partial<WorkSheetPrintDeps> = {}): WorkSheetPrintDeps {
  return {
    row: row(),
    liveColumns: [HOURS_COLUMN],
    workshopFromDirectory: () => 'Цех из справочника',
    ...over,
  };
}

type PrintModel = ReturnType<typeof buildWorkSheetPrintModel>;

function build(over: Partial<WorkSheetPrintDeps> = {}): PrintModel {
  return buildWorkSheetPrintModel(deps(over));
}

function sectionIds(model: PrintModel): string[] {
  return model.sections.map((s) => s.id);
}

function sectionHtml(model: PrintModel, id: string): string {
  return model.sections.find((s) => s.id === id)?.html ?? '';
}

/**
 * Всё, что дойдёт до глаз: секции листа плюс подписи окна предпросмотра. Сторожа
 * «этого на бумаге быть не должно» смотрят сюда, чтобы утечка через шапку окна не проскочила.
 */
function everythingShown(model: PrintModel): string {
  return [model.title, model.subtitle, ...model.sections.map((s) => `${s.title}\n${s.html}`)].join('\n');
}

/**
 * Формы листа, по которым сторожа «этого на бумаге быть не должно» обязаны пройтись все до
 * одной. Проверка на одной полной строке пропустила бы подстановки, которые вылезают только
 * на пустых местах: именно там на бумагу и лезли раньше коды и идентификаторы.
 */
function everyShape(): Array<[string, PrintModel]> {
  return [
    ['заполненная строка', build()],
    ['вид работ без имени', build({ row: row({ typeName: '   ' }) })],
    [
      'пустая строка: ни номера, ни цеха, ни полей, ни примечания, ни записавшего',
      build({
        row: row({ typeName: '', engineNumber: '', workshopName: '', performedBy: '', note: '', fields: [] }),
        liveColumns: [],
        workshopFromDirectory: () => '',
      }),
    ],
  ];
}

/**
 * Значение клетки под данной подписью. Ассерт должен говорить «под «Цех» стоит то-то», а не
 * «где-то на листе встречается это слово»: прочерк есть почти на каждом бланке, и поиск по
 * всему листу не доказал бы ничего.
 */
function cellUnder(html: string, label: string): string {
  const found = new RegExp(`<th[^>]*>${label}</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`).exec(html);
  return found?.[1] ?? '';
}

describe('buildWorkSheetPrintModel — печатный бланк одного этапа работ', () => {
  describe('состав листа', () => {
    it('собирает ровно пять согласованных секций в порядке чтения', () => {
      expect(
        sectionIds(build()),
        'порядок секций — это порядок чтения листа: чем он, для чего, что сделано, что замечено, кто подписал',
      ).toEqual(['title', 'meta', 'fields', 'note', 'sign']);
    });

    it('примечания нет — секции «Примечание» на листе тоже нет', () => {
      expect(
        sectionIds(build({ row: row({ note: '   ' }) })),
        'пустая секция вывела бы на бумагу заголовок и «Нет данных» — это мусор, а не документ',
      ).not.toContain('note');
    });

    it('у вида работ нет колонок и в строке нет полей — секции «Поля вида работ» нет вовсе', () => {
      expect(
        sectionIds(build({ row: row({ fields: [] }), liveColumns: [] })),
        'таблица без единой строки читается как потерянные данные',
      ).not.toContain('fields');
    });
  });

  describe('заголовок листа', () => {
    it('называет лист видом работ и номером двигателя — тем, что читает человек', () => {
      const model = build();
      const head = sectionHtml(model, 'title');
      expect(head, 'своего номера у этапа работ нет: опознать распечатку можно только видом работ').toContain(
        'Укладка вала',
      );
      expect(head, 'без номера двигателя лист не отличить от такого же по соседнему двигателю').toContain('TEST-001');
      expect(model.title, 'подпись окна предпросмотра называет тот же документ, что и сам лист').toContain(
        'Укладка вала',
      );
    });

    it('держит шапку отдельной секцией и не печатает её служебный заголовок', () => {
      const head = build().sections[0];
      expect(head?.id).toBe('title');
      expect(
        head?.hideTitle,
        'title окна предпросмотра лежит в блоке no-print и на бумагу не попадает — шапка обязана быть секцией, но собственный заголовок этой секции печатать нечего',
      ).toBe(true);
    });

    it('у вида работ нет имени — ставит родовое «Этап работ», а не служебный код', () => {
      const model = build({ row: row({ typeName: '   ' }) });
      expect(
        cellUnder(sectionHtml(model, 'meta'), 'Вид работ'),
        'заглушка обязана называть сущность её словарным именем: голое «Этап» запрещено, чужое имя сущности — тем более',
      ).toBe('Этап работ');
      expect(sectionHtml(model, 'title'), 'пустая шапка не называет документ вовсе').toContain('Этап работ');
      expect(everythingShown(model), 'код вида работ — служебный, оператору он ничего не говорит').not.toContain(
        TYPE_CODE,
      );
    });

    it('не зовёт этап работ ни «ведомостью», ни «узлом» — словарь один на всю программу', () => {
      for (const [shape, model] of everyShape()) {
        const shown = everythingShown(model);
        expect(
          shown,
          `${shape}: слово «ведомость» из интерфейса убрано — два имени одной сущности разводят операторов`,
        ).not.toMatch(/ведомост/i);
        expect(
          shown,
          `${shape}: узлом в программе зовётся сборочная единица — на бланке этапа работ это слово соврёт`,
        ).not.toMatch(/узел|узла|узлы|узлов/i);
      }
    });
  });

  describe('на бумагу не попадает ни один идентификатор', () => {
    it('не печатает id строки, двигателя, вида работ и цеха ни на одной форме листа', () => {
      const forbidden: Array<[string, string]> = [
        ['id строки', ROW_ID],
        ['id двигателя', ENGINE_ID],
        ['id вида работ', TYPE_ID],
        ['id цеха', WORKSHOP_ID],
        ['код вида работ', TYPE_CODE],
      ];
      for (const [shape, model] of everyShape()) {
        const shown = everythingShown(model);
        for (const [what, value] of forbidden) {
          expect(
            shown,
            `${shape}: ${what} на листе — опознать по нему объект человек не может, а читается он как испорченные данные; подставляют такое обычно как раз на месте пустой подписи`,
          ).not.toContain(value);
        }
        expect(
          shown,
          `${shape}: любой uuid-образный хвост на бумаге — та же поломка, даже если он приехал из поля, которого сегодня ещё нет`,
        ).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      }
    });

    it('двигатель без номера называется «(без номера)», а не пустотой и не своим id', () => {
      const model = build({ row: row({ engineNumber: '' }) });
      expect(
        cellUnder(sectionHtml(model, 'meta'), 'Двигатель'),
        'двигатель существует и просто не пронумерован — пустая клетка соврала бы, что её забыли заполнить',
      ).toBe(HUMAN_LABEL_NO_NUMBER);
      expect(
        everythingShown(model),
        'именно попытка «хоть как-то опознать строку» и приводила раньше к uuid на бумаге',
      ).not.toContain(ENGINE_ID);
    });
  });

  describe('цех — одна цепочка на три случая', () => {
    it('справочник знает цех — печатает его имя', () => {
      expect(
        cellUnder(sectionHtml(build(), 'meta'), 'Цех'),
        'справочник свежее снимка: цех переименовали — бумага обязана называть его сегодняшним именем',
      ).toBe('Цех из справочника');
    });

    it('справочник молчит — выручает снимок, записанный в саму строку', () => {
      expect(
        cellUnder(sectionHtml(build({ workshopFromDirectory: () => '' }), 'meta'), 'Цех'),
        'карточку открывают и не из списка (Ctrl+K, вторая панель) — справочник тогда пуст, но цех у строки известен',
      ).toBe('Цех из снимка');
    });

    it('ни справочника, ни снимка — прочерк, но не пустая клетка и не id цеха', () => {
      const model = build({ row: row({ workshopName: '' }), workshopFromDirectory: () => '' });
      expect(cellUnder(sectionHtml(model, 'meta'), 'Цех'), 'нет подписи — прочерк, таково правило проекта').toBe(
        HUMAN_LABEL_DASH,
      );
      expect(everythingShown(model), 'uuid цеха не опознаёт цех — он только выглядит как поломка').not.toContain(
        WORKSHOP_ID,
      );
    });
  });

  describe('таблица полей вида работ', () => {
    it('печатает значение колонки, которую из вида работ уже удалили', () => {
      const model = build({ row: row({ fields: [field(), REMOVED_FIELD] }) });
      expect(
        cellUnder(sectionHtml(model, 'fields'), 'Снятая колонка'),
        'на экране такой колонки уже нет, но в строке значение записано — бумага обязана показать записанное, иначе она молча теряет данные',
      ).toBe('записано');
    });

    it('живые колонки идут впереди, хвост из строки — следом', () => {
      const model = build({ row: row({ fields: [REMOVED_FIELD, field()] }) });
      const html = sectionHtml(model, 'fields');
      expect(
        html.indexOf('Часы обкатки'),
        'порядок на листе задаёт живой вид работ, а не порядок хранения полей в строке: бумага должна читаться как экран',
      ).toBeLessThan(html.indexOf('Снятая колонка'));
    });

    it('вид работ недоступен — таблица всё равно полная, подписи берутся из строки', () => {
      const html = sectionHtml(build({ liveColumns: [], row: row({ fields: [field(), REMOVED_FIELD] }) }), 'fields');
      expect(
        cellUnder(html, 'Часы обкатки'),
        'клиент офлайн или вид работ заархивирован — строка самоописываема и печатается без справочника',
      ).toBe('12,5');
      expect(cellUnder(html, 'Снятая колонка'), 'справочник нужен бланку только ради порядка колонок').toBe('записано');
    });
  });

  describe('значения полей', () => {
    function withField(over: Partial<WorkSheetField>): string {
      return sectionHtml(build({ liveColumns: [], row: row({ fields: [field(over)] }) }), 'fields');
    }

    it('незаполненное поле — прочерк, а не пустая клетка', () => {
      expect(
        cellUnder(withField({ code: 'ok', label: 'Принято', type: 'boolean', value: null }), 'Принято'),
        'это бланк-отчёт о сделанном, а не бланк под заполнение ручкой: пустая клетка приглашает дописать задним числом',
      ).toBe(HUMAN_LABEL_DASH);
    });

    it('явное «нет» печатается словом и не сливается с незаполненным', () => {
      expect(
        cellUnder(withField({ code: 'ok', label: 'Принято', type: 'boolean', value: false }), 'Принято'),
        'на экране пустой и снятый флажок выглядят одинаково — на бумаге «нет» обязано отличаться от «не заполняли»',
      ).toBe('нет');
    });

    it('дата печатается так же, как её набирали в карточке', () => {
      const model = build({ liveColumns: [], row: row({ fields: [field({ code: 'done_at', label: 'Дата сдачи', type: 'date', value: AT })] }) });
      expect(
        cellUnder(sectionHtml(model, 'fields'), 'Дата сдачи'),
        'карточка рисует дату по местному времени — бумага, считающая по Москве, разошлась бы с экраном на день',
      ).toBe('15.09.2026');
      expect(cellUnder(sectionHtml(model, 'meta'), 'Дата'), 'дата этапа работ считается тем же правилом').toBe(
        '15.09.2026',
      );
    });

    it('число печатается с запятой — как его пишут в цеху', () => {
      expect(
        cellUnder(withField({ value: 12.5 }), 'Часы обкатки'),
        'точка в дробном числе читается тут как опечатка, а не как разделитель',
      ).toBe('12,5');
    });

    it('переносы строк оператора остаются переносами на бумаге', () => {
      const html = sectionHtml(build({ row: row({ note: 'Первая строка\nВторая строка' }) }), 'note');
      expect(html, 'в текстовое поле влезает до 500 символов — без переносов примечание слипнется в кашу').toContain(
        '<br',
      );
      expect(html).toContain('Первая строка');
      expect(html).toContain('Вторая строка');
    });

    it('текст, принесённый из чужого документа, не становится разметкой', () => {
      const html = sectionHtml(build({ row: row({ note: '<b>стук</b> & задир' }) }), 'note');
      expect(html, 'оператор вставляет примечание копипастом — угловые скобки обязаны остаться текстом').toContain(
        '&lt;b&gt;стук&lt;/b&gt;',
      );
      expect(html).toContain('&amp;');
      expect(html, 'иначе часть примечания исчезнет с листа, превратившись в тег').not.toContain('<b>стук</b>');
    });
  });

  describe('кто записал', () => {
    it('ставит логин под честной подписью «Кто записал»', () => {
      expect(
        cellUnder(sectionHtml(build(), 'meta'), 'Кто записал'),
        'в строке лежит логин того, кто сохранял её последним, — бумага обязана называть это тем же словом, что и список',
      ).toBe('oper');
    });

    it('не называет логин исполнителем', () => {
      expect(
        everythingShown(build()),
        'сервер переписывает это поле на того, кто правил строку последним: назвать его исполнителем значило бы напечатать неправду, а логин под подписью «Исполнитель» — это идентификатор, притворяющийся именем',
      ).not.toContain('Исполнитель');
    });

    it('никто не записан — прочерк, а не пустая клетка', () => {
      expect(
        cellUnder(sectionHtml(build({ row: row({ performedBy: '' }) }), 'meta'), 'Кто записал'),
        'нет подписи — прочерк: пустая клетка выглядит как место, оставленное под запись',
      ).toBe(HUMAN_LABEL_DASH);
    });
  });

  describe('место под подпись', () => {
    it('оставляет роль и пустую линию — подписывают лист живой рукой', () => {
      const html = sectionHtml(build(), 'sign');
      expect(html, 'без названия роли непонятно, кто именно расписывается').toMatch(/выполнил/i);
      expect(html, 'пустая линия и есть то место, которое оставлено человеку с ручкой').toContain('border-bottom');
    });

    it('не ставит грифа «Утверждаю» и ни одного ФИО', () => {
      const html = sectionHtml(build(), 'sign');
      expect(
        html,
        'гриф в новой печатной форме расширил бы ПДн-границу, сознательно замороженную решением владельца',
      ).not.toMatch(/утверждаю/i);
      for (const approver of Object.values(WORK_ORDER_APPROVERS)) {
        expect(html, 'ФИО утверждающего живёт литералом в замороженном SSOT наряда — на новый бланк оно не переезжает').not.toContain(
          approver.name,
        );
        expect(html, 'должность с названием завода — часть той же замороженной границы').not.toContain(
          approver.position,
        );
      }
      expect(
        html,
        'любое ФИО вида «И.О. Фамилия» на бланке — та же ПДн-граница, даже если источник у него новый',
      ).not.toMatch(/[А-ЯЁ]\.\s?[А-ЯЁ]\.\s?[А-ЯЁ][а-яё]+/);
    });
  });
});
