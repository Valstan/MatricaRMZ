import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож двух молчаливых потерь данных в акте (оба чинились 2026-09-08).
//
// Строка листа пересобирается из шаблона марки при каждом открытии карточки
// (brand-resync). Операторские поля переживают его только потому, что merge-коллбек
// переносит их из prev поимённо: у строки марки этих полей нет, и забытое поле
// стирается тихо — типы и линт целы, а введённый текст исчезает к следующему заходу.
// Ровно так пропадала «причина утиля».
//
// Шапка акта досыпается из карточки двигателя, которая шлёт пропсы на каждое нажатие.
// Признаком «поле ничьё» когда-то была пустота — и в акт уезжала первая буква номера.
// Правило владения живёт в домене (`resolveHeaderAutofill`, покрыт своим тестом);
// здесь сторожится только то, что панель им пользуется и помнит владение в ref.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PANEL = src('./RepairChecklistPanel.tsx');

describe('RepairChecklistPanel: операторские данные переживают brand-resync', () => {
  it('merge-коллбек engine_inventory переносит scrap_reason из прежней строки', () => {
    expect(PANEL).toContain("? { scrap_reason: String((prev as any).scrap_reason) }");
  });

  it('переносит и остальные операторские поля строки', () => {
    for (const field of ['stamped_number', 'replenishment_branch', 'scrap_qty', 'replace_qty']) {
      expect(PANEL).toContain(field);
    }
  });
});

// Автозаполнение нового двигателя (10.09.2026): панель сама писала лист под id карточки, у
// которой ещё нет строки двигателя. Main откладывает такие записи только если знает, что это
// автозаполнение, — поэтому каждое сохранение из эффекта обязано нести `auto`.
describe('RepairChecklistPanel: автозаполнение не создаёт лист раньше двигателя', () => {
  it('ни одно сохранение из эффекта не идёт без пометки auto', () => {
    expect(PANEL).not.toContain('if (props.canEdit) void save(next);');
    expect(PANEL.split('void save(next, { auto: true });').length - 1).toBe(7);
  });

  it('пометка доезжает до main и отложенный лист дописывается', () => {
    expect(PANEL).toContain('...(auto ? { auto: true } : {}),');
    expect(PANEL).toContain("if ('deferred' in r) {");
    expect(PANEL).toContain('if (!props.engineStored || deferredAutoSaveRef.current == null) return;');
  });
});

describe('RepairChecklistPanel: автоподстановка шапки', () => {
  it('решение о записи принимает доменная функция, а не проверка «поле пустое»', () => {
    expect(PANEL).toContain('resolveHeaderAutofill({');
    expect(PANEL).toContain('owned: headerAutofillRef.current[id],');
  });

  it('владение фиксируется ТОЛЬКО когда значение фактически оказалось в поле', () => {
    // Запись может не закрепиться: brand-resync сохраняет лист со своим снимком answers и
    // возвращает шапку пустой. Запомни мы владение авансом — следующий проход прочитал бы
    // «поле пустое, писали его мы» как «оператор стёр руками», и номер не доехал бы уже
    // никогда. Поэтому ref пишется в ветке adopt, а в ветке write его быть не должно.
    const fill = PANEL.slice(PANEL.indexOf('const fillText ='), PANEL.indexOf("fillText('engine_brand'"));
    const adoptAt = fill.indexOf("if (decision.action === 'adopt') {");
    const refAt = fill.indexOf('headerAutofillRef.current[id] = decision.value;');
    const writeAt = fill.indexOf('(next as any)[id] = { kind:');
    expect(adoptAt, 'ветка adopt пропала').toBeGreaterThan(-1);
    expect(refAt, 'владение больше нигде не запоминается').toBeGreaterThan(adoptAt);
    expect(refAt, 'владение записывается ДО подтверждения — вернётся «первая буква»').toBeLessThan(writeAt);
  });

  it('сбрасывает владение при перезагрузке листа', () => {
    expect(PANEL).toContain('headerAutofillRef.current = {};');
  });

  it('перенятое владение не считается изменением листа', () => {
    // Взведи ветка adopt `changed` — панель уходила бы в автосейв на каждую перерисовку.
    const fill = PANEL.slice(PANEL.indexOf('const fillText ='), PANEL.indexOf("fillText('engine_brand'"));
    const adopt = fill.slice(fill.indexOf("if (decision.action === 'adopt') {"), fill.indexOf('(next as any)[id] = { kind:'));
    expect(adopt).not.toContain('changed = true;');
  });
});

// Номер двигателя на картерах (14.09.2026): верхняя и нижняя половины несут номер самого
// двигателя, и оператор вбивал его руками в две строки на каждом двигателе. Подстановка идёт
// из того же эффекта, что и шапка, и опирается на доменную функцию — признак «что такое
// картер» обязан быть общим с авто-браком двигателя, иначе они разойдутся молча.
describe('RepairChecklistPanel: номер двигателя в «№ на детали» картеров', () => {
  it('подстановку делает доменная функция, а не своя проверка имени в панели', () => {
    expect(PANEL).toContain('fillCrankcaseStampedNumbers({ rows: current.rows, engineNumber: num });');
    expect(PANEL, 'признак картера не должен дублироваться в панели').not.toContain("includes('картер')");
  });

  it('результат уезжает в тот же answers и сохраняется автозаполнением', () => {
    expect(PANEL).toContain("(next as any)[table.id] = { kind: 'table', rows: filled.rows };");
  });
});

// D1 (осень-2026): «Детали и акты» разрезаны на две вкладки карточки — «Акт комплектности» и «Акт
// дефектовки», — но панель осталась ОДНА на оба акта: один `answers`, одно сохранение (main пишет
// metaJson полной заменой, checklistService.ts). Четыре блока ниже держат свойства этого разреза:
// вид акта приходит снаружи, содержимое секций не размонтируется, память свёрнутости у каждого акта
// своя, а дефектовочный хвост не вылезает на комплектность.

describe('RepairChecklistPanel: вид акта задаёт вкладка, а не сама панель', () => {
  it('панель не хранит и не переключает вид акта — только читает проп', () => {
    // Свой useState вида — это второй источник правды: вкладка карточки говорит «дефектовка», а
    // панель (колонки таблицы, кнопки печати, гейты хвоста) продолжает жить на комплектности.
    expect(PANEL, 'вид акта снова переключается изнутри — вкладка карточки перестанет им управлять').not.toContain(
      'setActView',
    );
    expect(PANEL, 'вид акта заведён состоянием панели — он обязан приходить снаружи').not.toMatch(/\[\s*actView\s*,/);
    expect(PANEL, 'панель обязана читать вид акта из пропа: его задаёт активная вкладка карточки').toContain(
      'props.actView',
    );
  });
});

describe('RepairChecklistPanel: свёрнутый блок акта прячется, а не размонтируется', () => {
  const SECTION_AT = PANEL.indexOf('const renderSection =');
  const SECTION_END = PANEL.indexOf('const actItemVisible');
  const SECTION = PANEL.slice(SECTION_AT, SECTION_END);

  it('рендерер секции на месте (иначе остальные ассерты блока проверяют пустоту)', () => {
    expect(SECTION_AT, 'рендерер сворачиваемой секции не найден — сторож ослеп').toBeGreaterThan(-1);
    expect(SECTION_END, 'конец рендерера не найден — срез захватил бы пол-панели').toBeGreaterThan(SECTION_AT);
  });

  it('содержимое скрывается атрибутом hidden, а не условием {open && …}', () => {
    // Так рисует общий CollapsibleSection — и теряет состояние: у «Деталей» внутри живая таблица
    // (раскрытые группы, цифровая клавиатура), она сбрасывалась бы на каждом сворачивании.
    expect(SECTION, 'секция обязана скрываться атрибутом: иначе таблица деталей теряет своё состояние').toContain(
      'hidden={!open}',
    );
    expect(SECTION, 'секция рисует содержимое через {open && …} — это размонтирование таблицы деталей').not.toContain(
      '{open &&',
    );
  });

  it('на скрываемой секции нет ни инлайнового display, ни overflow', () => {
    // display на скрываемом узле перебивает hidden (M78) — блок останется видимым на чужой вкладке.
    // overflow сделал бы секцию скролл-контейнером и отцепил sticky-шапку таблицы деталей от
    // прокрутки карточки: шапка просто уезжает вверх вместе со строками.
    expect(SECTION, 'инлайновый display на скрываемом узле перебьёт hidden (M78)').not.toMatch(/\bdisplay\b/);
    expect(SECTION, 'overflow отцепит sticky-шапку таблицы деталей от прокрутки карточки').not.toMatch(/\boverflow\b/);
  });
});

describe('RepairChecklistPanel: свёрнутость блоков помнится у каждого акта своя', () => {
  it('у комплектности и дефектовки раздельные ключи, и выбор идёт по виду акта', () => {
    expect(PANEL, 'память свёрнутости комплектности пропала').toContain(
      "useListUiState('card:engine:acts:completeness:ui'",
    );
    expect(PANEL, 'память свёрнутости дефектовки пропала').toContain("useListUiState('card:engine:acts:defect:ui'");
    expect(PANEL, 'блоки обязаны брать свёрнутость по открытому акту, иначе память у актов общая').toContain(
      'isDefectView ? defectSections : completenessSections',
    );
  });

  it('ключ хранилища не собирается из вида акта на лету', () => {
    // useListUiState читает хранилище ТОЛЬКО в инициализаторе, а пишет по изменению состояния.
    // Один вызов с динамическим ключом не перечитал бы чужую память при переключении вкладки, зато
    // немедленно записал бы поверх неё: свёрнутость комплектности уехала бы в ключ дефектовки.
    expect(PANEL, 'ключ ui-состояния собран шаблонной строкой — состояние одного акта затрёт другой').not.toMatch(
      /useListUiState\(\s*`/,
    );
    expect(PANEL, 'вид акта подставляется в ключ хранилища — память актов схлопнется в одну').not.toContain(
      'card:engine:acts:${',
    );
  });
});

describe('RepairChecklistPanel: дефектовочный хвост живёт только на дефектовке', () => {
  // Хвост после таблицы собирает результат дефектовки: заявка берёт строки «заказать новую», наряд —
  // «свой ремонт», остальное появляется после проведения. На «Акте комплектности» этих блоков нет —
  // и это должно держаться гейтом вида, а не тем, что данных обычно нет.
  const TOP_GATES = PANEL.split(/\r?\n/).filter((line) => line.trimStart().startsWith('{!collapsed &&'));
  const TAIL: [string, string][] = [
    ['props.onCreateSupplyRequestFromDefects', 'заявка в снабжение'],
    // D2: сама кнопка «Провести дефектовку» уехала в ряд шапки, но маркер остался общим — теперь
    // его несут блок наряда, кнопка проводки в шапке и рамка состояния в хвосте. Проверка не
    // ослаблена: гейт по виду акта обязателен у всех трёх (иначе они вылезут на комплектность).
    ['props.canCreateWorkOrder', 'ремонтный наряд, кнопка проводки и её состояние'],
    ['defectPartHistory.length', 'история деталей'],
    ['stampedInstances.length', 'личные номера экземпляров'],
    ['requirementVersions.length', 'версии требования'],
    ['partStatusEvents.length', 'история статусов деталей'],
  ];

  for (const [marker, human] of TAIL) {
    it(`блок «${human}» показывается только при виде «дефектовка»`, () => {
      const gates = TOP_GATES.filter((line) => line.includes(marker));
      expect(gates.length, `блок «${human}» больше не рисуется своим гейтом — сторож проверяет пустоту`).toBeGreaterThan(
        0,
      );
      for (const gate of gates) {
        expect(gate.trim(), `блок «${human}» вылезет на «Акт комплектности», где он бессмыслен`).toContain(
          'isDefectView',
        );
      }
    });
  }
});

// D2 (осень-2026): «Провести дефектовку» переехала из синей рамки хвоста в плоский ряд шапки, и
// рядом с ней встала новая «Провести комплектность». У проводки, в отличие от любого поля акта,
// ответ приходит не в само поле, а строкой статуса панели — единственным каналом («Дефектовка
// проведена…», «привяжите к справочнику строки…», «Комплектность уже проведена…»). Поэтому
// размещение кнопки здесь не оформление, а работоспособность: уедь кнопка туда, где статуса не
// видно (свёрнутая панель), или спрячься за чужим правом (печать) — оператор жмёт вслепую.
describe('RepairChecklistPanel: кнопки проводки живут в ряду шапки', () => {
  const LINES = PANEL.split(/\r?\n/);
  const TITLE_AT = LINES.findIndex((l) => l.includes('<strong>{panelTitle}</strong>'));
  // Начало ряда шапки — его открывающий <div ... flexWrap: 'wrap'>. Он ВЫШЕ заголовка:
  // с 01.11.2026 кнопки проводки стоят в самом начале ряда (владелец: до них тянулись
  // через всю шапку, до печати). Раньше началом ряда считался заголовок.
  const ROW_START = LINES.findIndex((l, i) => i < TITLE_AT && l.includes("flexWrap: 'wrap'"));
  const ROW_END = LINES.findIndex((l, i) => i > TITLE_AT && /^ {6}<\/div>\s*$/.test(l));
  const STATUS_AT = LINES.findIndex((l) => l.includes('{status && <div'));

  // Маркер подписи берём вместе с закрывающей скобкой JSX-выражения: так он ловит только сам узел
  // подписи и не считает ни доккоммент функции проводки, ни title кнопки, где те же слова.
  const BUTTONS: { marker: string; human: string; gate: string[] }[] = [
    {
      marker: "'Провести комплектность'}",
      human: 'комплектность',
      // Кнопка пишет то же поле того же листа, что и любая правка акта, — и правом ей служит право
      // правки, а не work_orders.create: нарядов она не создаёт и склад не двигает.
      gate: ['isCompletenessView', 'props.canEdit'],
    },
    {
      marker: "'Провести дефектовку'}",
      human: 'дефектовка',
      gate: ['isDefectView', 'props.canCreateWorkOrder'],
    },
  ];

  function labelAt(marker: string): number {
    const found = LINES.map((l, i) => (l.includes(marker) ? i : -1)).filter((i) => i >= 0);
    expect(
      found.length,
      `подпись ${marker} встречается ${found.length} раз вместо одного: кнопку скопировали, а не перенесли — два экземпляра проводки на одной панели`,
    ).toBe(1);
    return found[0] ?? -1;
  }

  function gateOf(at: number): string {
    for (let i = at; i >= 0; i--) {
      const line = LINES[i] ?? '';
      if (line.trimStart().startsWith('{!collapsed &&')) return line.trim();
    }
    return '';
  }

  it('якоря ряда шапки и строки статуса на месте (иначе ассерты блока проверяют пустоту)', () => {
    expect(TITLE_AT, 'заголовок панели не найден — ряд шапки больше нечем опознать').toBeGreaterThan(-1);
    expect(ROW_START, 'начало ряда шапки не найдено — «в шапке или нет» измерить не по чему').toBeGreaterThan(-1);
    expect(ROW_START, 'начало ряда шапки должно быть выше заголовка панели').toBeLessThan(TITLE_AT);
    expect(ROW_END, 'закрытие ряда шапки не найдено — «в шапке или нет» измерить не по чему').toBeGreaterThan(TITLE_AT);
    expect(STATUS_AT, 'строка статуса не найдена — ответу проводки негде появиться').toBeGreaterThan(ROW_END);
  });

  it('ряд шапки переносится: без переноса кнопки уезжают за край карточки', () => {
    // Без переноса первой схлопывается распорка flex: 1, а дальше кнопки уезжают за край карточки
    // на 1024–1366 px — проводка становится недостижимой ровно на тех экранах, где она нужна.
    expect(LINES[ROW_START], 'ряд шапки потерял перенос — кнопки уедут за край карточки на узком окне').toContain(
      "flexWrap: 'wrap'",
    );
  });

  for (const { marker, human } of BUTTONS) {
    it(`кнопка проводки (${human}) стоит в начале ряда шапки, до заголовка`, () => {
      // Владелец, 01.11.2026: кнопка уехала вправо, до неё тянулись через всю шапку.
      const at = labelAt(marker);
      expect(
        at,
        `кнопка проводки (${human}) уехала вправо от заголовка панели — до неё дотягиваются через всю шапку, до печати`,
      ).toBeLessThan(TITLE_AT);
      expect(
        at,
        `кнопка проводки (${human}) выпала из ряда шапки: в хвосте её приходится искать прокруткой под таблицей деталей`,
      ).toBeGreaterThan(ROW_START);
      expect(
        at,
        `кнопка проводки (${human}) вывалилась из ряда шапки: в хвосте её приходится искать прокруткой под таблицей деталей`,
      ).toBeLessThan(ROW_END);
      expect(
        at,
        `кнопка проводки (${human}) стоит ниже строки статуса — оператор нажмёт и не увидит ответа, он останется выше по экрану`,
      ).toBeLessThan(STATUS_AT);
    });
  }

  for (const { marker, human, gate } of BUTTONS) {
    it(`гейт кнопки проводки (${human}) — вид акта и своё право, но не право печати`, () => {
      const gateLine = gateOf(labelAt(marker));
      expect(gateLine, `кнопка проводки (${human}) больше не под гейтом !collapsed — сторож проверяет пустоту`).not.toBe(
        '',
      );
      for (const marker2 of gate) {
        expect(
          gateLine,
          `кнопка проводки (${human}) потеряла «${marker2}» — она вылезет на чужой вкладке или у оператора без права`,
        ).toContain(marker2);
      }
      expect(
        gateLine,
        `ответ проводки (${human}) рисует строка статуса, а она живёт в развёрнутой панели: без !collapsed кнопка работала бы молча`,
      ).toContain('!collapsed');
      expect(
        gateLine,
        `проводка (${human}) заехала под право печати — она исчезнет на планшете (canPrint гасится Android) и у всех, кому reports.print не выдан`,
      ).not.toContain('canPrint');
    });
  }
});

// Проводка комплектности — не серверная транзакция, а обычное сохранение листа: дата осмотра
// пишется тем же save() и тем же IPC, что и любая правка акта. Значит и ломается она тихо —
// повторной записью поверх уже стоящей даты, записью в поле, которого нет в активном шаблоне
// (оператор такую дату не увидит и не исправит), и пометкой auto, по которой main вправе отложить
// лист: запись не ляжет, а кнопка отрапортует об успехе.
describe('RepairChecklistPanel: проводка комплектности пишет дату один раз и видит отказ', () => {
  const AT = PANEL.indexOf('async function conductCompleteness()');
  const END = PANEL.indexOf('function exportJson()', AT);
  const CONDUCT = PANEL.slice(AT, END);
  const SAVE_AT = CONDUCT.indexOf('await save(');

  it('функция проводки на месте (иначе ассерты блока проверяют пустоту)', () => {
    expect(AT, 'conductCompleteness не найдена — сторож ослеп').toBeGreaterThan(-1);
    expect(END, 'конец функции не найден — срез захватил бы пол-панели').toBeGreaterThan(AT);
    expect(SAVE_AT, 'проводка больше ничего не сохраняет — мерить «до записи» не по чему').toBeGreaterThan(-1);
  });

  it('ждёт результата записи и НЕ помечает её auto', () => {
    expect(PANEL, 'save() перестал отвечать, легла ли запись — проводке нечего дождаться').toContain(
      '): Promise<boolean> {',
    );
    expect(
      CONDUCT,
      'проводка не ждёт результата записи: при отказе и при отложенном листе она всё равно скажет «проведена»',
    ).toContain('const written = await save(next);');
    expect(
      CONDUCT,
      'пометка auto даёт main право отложить лист — дата не ляжет, а статус отрапортует об успехе',
    ).not.toMatch(/\bauto\b\s*:/);
    expect(
      CONDUCT,
      'проводке передали опции сохранения: единственная допустимая — никаких, иначе запись снова станет откладываемой',
    ).not.toMatch(/save\(\s*next\s*,/);
  });

  it('«Сохранено» гасит само себя и не затирает ответ проводки', () => {
    // Таймер save() стирал статус вслепую: через 700 мс после записи оператор видел пустоту вместо
    // «Комплектность проведена…» — единственного подтверждения, что дата встала.
    expect(PANEL, 'таймер save() снова стирает любой статус — ответ проводки исчезнет через 700 мс').toContain(
      "setStatus((cur) => (cur === 'Сохранено' ? '' : cur))",
    );
  });

  it('дата пишется только в пустое поле: повтор выходит ДО записи', () => {
    const already = CONDUCT.indexOf('Комплектность уже проведена');
    expect(already, 'ответа на повторное нажатие больше нет — повтор станет молчаливым').toBeGreaterThan(-1);
    expect(
      already,
      'проверка «дата уже стоит» ушла за сохранение: второе нажатие перепишет дату осмотра на сегодня и сдвинет этап двигателя',
    ).toBeLessThan(SAVE_AT);
    expect(CONDUCT, 'носитель этапа — существующая дата осмотра листа, второго её источника быть не должно').toContain(
      "completeness_inspection_date: { kind: 'date'",
    );
  });

  it('отказывает, если поля даты нет в активном шаблоне — запись была бы невидимой', () => {
    const noField = CONDUCT.indexOf('в шаблоне акта нет поля');
    expect(
      noField,
      'защиты от невидимой записи нет: дата уедет в answers, но поля в форме не будет — поправить её оператор не сможет',
    ).toBeGreaterThan(-1);
    expect(noField, 'проверка шаблона стоит после сохранения — она уже ничего не предотвращает').toBeLessThan(SAVE_AT);
    expect(CONDUCT, 'проверять надо наличие в шаблоне именно поля даты осмотра').toContain(
      "activeTemplate.items.some((it) => it.id === 'completeness_inspection_date')",
    );
  });
});

// Дата прихода = дата приёмки = дата акта комплектности (таблица 05.10.2026, PR4).
// Замер прода 05.10: 1878 карточек с датой прихода, у 655 листов своя `arrival_date`,
// у 100 — своя дата осмотра, и 60 движков с расхождением между карточкой и актом.
// Пока лист тянет свою дату, это два носителя одной даты и они расходятся.
describe('RepairChecklistPanel: дата приёма — из карточки, а не второй носитель', () => {
  it('дата осмотра НЕ автозаполняется — иначе акт «проведён» без кнопки', () => {
    // Ключевой вывод первого прогона смоука: автозаполнение `completeness_inspection_date`
    // означало, что печатный акт уезжает с датой осмотра, которую никто не проводил.
    // Единство даты достигается ЗНАЧЕНИЕМ (кнопка берёт дату карточки), а не автозаполнением.
    const AUTOFILL = PANEL.slice(
      PANEL.indexOf('const fillText'),
      PANEL.indexOf('const fillText') + 4200,
    );
    expect(
      AUTOFILL,
      'дата осмотра снова заполняется из карточки — акт будет печатать несостоявшуюся проверку',
    ).not.toContain("'completeness_inspection_date']");
  });

  it('проведение комплектности берёт дату карточки, а не «сегодня»', () => {
    const CONDUCT = PANEL.slice(PANEL.indexOf('async function conductCompleteness()'));
    expect(
      CONDUCT.slice(0, 3000),
      'кнопка снова пишет свою дату (Date.now) — это ровно тот второй носитель, который сняли',
    ).toContain('cardArrival');
    expect(CONDUCT.slice(0, 3000), 'дата приёма должна приходить из карточки').toContain('props.arrivalDate');
    // Значение одно: лист пишется inspectionAt, а этап выводится из него читателями —
    // прежде этой же датой писалась и отдельная строка этапа (второй носитель).
    expect(CONDUCT.slice(0, 6000), 'лист должен писаться датой карточки/осмотра').toContain('value: inspectionAt');
  });

  it('пустую дату прихода кнопка дописывает в карточку тем же путём, что и поле карточки', () => {
    const CONDUCT = PANEL.slice(PANEL.indexOf('async function conductCompleteness()'));
    expect(
      CONDUCT.slice(0, 3600),
      'дата осмотра в акте без даты прихода в карточке снова заводит второй носитель',
    ).toContain("window.matrica.engines.setAttr(props.engineId, 'arrival_date', inspectionAt)");
    // Право у этого вызова — engines.edit, а панель гейтится operations.edit: отказ
    // обязан быть виден словами, иначе «мастер» увидит «проведено» при пустой карточке.
    expect(CONDUCT.slice(0, 4200)).toContain('Дата прихода в карточке не заполнилась');
  });
});

// Пп. 2–3 таблицы 05.10.2026 (решения владельца 07.10.2026).
describe('RepairChecklistPanel: накладная прихода и дата этапа дефектовки', () => {
  it('номер накладной прихода из карточки уезжает в печать акта комплектности', () => {
    expect(PANEL, 'проп накладной не заведён').toContain('arrivalInvoice?: string');
    expect(PANEL, 'накладная не доезжает до печатного контекста').toContain(
      "...(props.arrivalInvoice ? { arrivalInvoice: String(props.arrivalInvoice) } : {}),",
    );
  });

  it('дата этапа «Разборка/Дефектовка» подставляется в поле листа — только в пустое', () => {
    const AUTOFILL = PANEL.slice(PANEL.indexOf('const fillText'), PANEL.indexOf('const fillText') + 5200);
    expect(AUTOFILL, 'подстановка даты этапа дефектовки пропала').toContain("hasItem('defect_start_date')");
    expect(AUTOFILL, 'подстановка должна уважать введённое оператором').toContain('current == null');
  });

  it('подстановка даты НЕ проводит акт: проведение остаётся отдельной кнопкой', () => {
    // Дата — факт события, а не факт проверки: `completeness_inspection_date` по-прежнему
    // ставится только кнопкой, а дефектовка проводится `conductDefect`/версией на сервере.
    const AUTOFILL = PANEL.slice(PANEL.indexOf('const fillText'), PANEL.indexOf('const fillText') + 5200);
    expect(AUTOFILL, 'дата осмотра снова автозаполняется — акт «проведён» без кнопки').not.toContain(
      "'completeness_inspection_date']",
    );
  });
});

describe('RepairChecklistPanel: проведение дефектовки без даты заблокировано (09.10.2026)', () => {
  it('conductDefect требует defect_start_date до снимка', () => {
    expect(PANEL, 'проведение без даты ушло на сервер — этап встанет не на своё место').toContain(
      'без неё провести дефектовку нельзя.',
    );
  });

  it('смена даты в акте двигает этап без подтверждения — двигать нечего', () => {
    // Унификация актов, шаг 3: отдельной строки этапа больше нет, этап выводится
    // из даты акта сам — подтверждение смены даты не нужно, фолбэка на «сегодня» нет.
    expect(PANEL).not.toContain('Сменить дату этапа «Разборка/Дефектовка»?');
    expect(PANEL).not.toContain('confirmDefectDate');
  });
});

describe('RepairChecklistPanel: блок «Базовые детали» раскрыт с первого захода (D5, владелец 17.09.2026)', () => {  it('базовые детали открыты по умолчанию, остальные — свёрнуты', () => {
    expect(PANEL).toContain('const [baseGroupOpen, setBaseGroupOpen] = useState(true);');
    expect(PANEL).toContain('const [otherGroupOpen, setOtherGroupOpen] = useState(false);');
  });
});

// Выгрузка в Word ≠ печать (P5b-2, 19.10.2026): обе двери ведут к ОДНОЙ печатной форме
// (`actHtml` / `buildEngineRequirementHtml`), но версию-снимок фиксирует только печать — она
// отмечает, что именно ушло заказчику. Уедь снимок в выгрузку — каждое «Акт в Word» плодило бы
// версию в истории актов, ничего никому не отправив, и «История версий» перестала бы что-либо
// значить. Смоук этого не поймает там, где версий ещё нет (0 до = 0 после), поэтому граница
// сторожится по исходнику.
describe('RepairChecklistPanel: выгрузка в Word не создаёт версию-снимок', () => {
  function fn(from: string, to: string): string {
    const at = PANEL.indexOf(from);
    const end = PANEL.indexOf(to, at);
    expect(at, `«${from}» не найдена — сторож ослеп`).toBeGreaterThan(-1);
    expect(end, `конец «${from}» не найден — срез захватил бы пол-панели`).toBeGreaterThan(at);
    return PANEL.slice(at, end);
  }

  const ACT_EXPORT = fn('async function exportActToWord', 'async function exportRequirementToWord');
  const REQ_EXPORT = fn('async function exportRequirementToWord', 'const attachmentsTitle');

  it('акт и требование выгружаются через IPC выгрузки, а форму берут у печати', () => {
    expect(ACT_EXPORT, 'форма акта в выгрузке собирается не тем сборщиком, что в печати — формы разъедутся').toContain(
      'actHtml(',
    );
    expect(ACT_EXPORT, 'выгрузка акта больше не идёт каналом выгрузки').toContain('window.matrica.exports.card(');
    expect(REQ_EXPORT, 'требование в Word снова собирается своим сборщиком').toContain(
      'buildEngineRequirementHtml(',
    );
    expect(REQ_EXPORT, 'выгрузка требования больше не идёт каналом выгрузки').toContain(
      'window.matrica.exports.card(',
    );
  });

  it('снимок версии пишет печать, а не выгрузка', () => {
    const actPrint = fn('async function printAct(', 'function printBlankAct');
    const reqPrint = fn('async function printRequirement(', 'function printDefectHistoryAttachment');
    expect(actPrint, 'печать акта перестала фиксировать версию — история актов опустеет').toContain(
      'engineActSnapshot',
    );
    expect(reqPrint, 'печать требования перестала фиксировать версию').toContain('requirementSnapshot');
    expect(
      ACT_EXPORT,
      'выгрузка акта начала писать версию-снимок — история версий наполнится выгрузками',
    ).not.toContain('engineActSnapshot');
    expect(REQ_EXPORT, 'выгрузка требования начала писать версию-снимок').not.toContain('requirementSnapshot');
  });
});

// Решения владельца от 01.11.2026 по вкладке «Акторы сборки, дефектовки» карточки двигателя:
// кнопка проводки — в край слева, «Оформление» — открыт и несворачиваем, гриф — в «Сведения»,
// в списке деталей — поиск, сортировка по шапкам и подсветка столбца «Утиль», а кнопка «Фото»
// из строк убрана (фото прикрепляются к двигателю). Решения владельца — их и держим сторожем.
describe('RepairChecklistPanel: решения владельца от 01.11.2026 (карточка двигателя)', () => {
  const LINES = PANEL.split(/\r?\n/);
  const at = (needle: string) => LINES.findIndex((l) => l.includes(needle));

  it('«Оформление» (разборка, даты, подписи) — раскрыт и НЕ сворачивается', () => {
    const start = at("renderSection('Оформление'");
    expect(start, 'блок «Оформление» не найден — разборку снова спрячут под щелчок').toBeGreaterThan(-1);
    const tail = LINES.slice(start, start + 6).join('\n');
    expect(tail, '«Оформление» перестало быть раскрытым — заполнить разборку и подпись можно только после щелчка').toContain(
      "renderSection('Оформление', true",
    );
    expect(tail, '«Оформление» снова сворачивается — владелец просил, чтобы блок не сворачивался').toContain('), false)}');
  });

  it('гриф «Утверждаю» живёт внутри сворачиваемого блока «Сведения»', () => {
    const info = at("renderSection('Сведения'");
    const grif = at('{renderApproverGrifBlock()}');
    const parts = at("renderSection('Детали'");
    expect(info, 'блок «Сведения» не найден').toBeGreaterThan(-1);
    expect(grif, 'гриф «Утверждаю» никуда не переехал').toBeGreaterThan(-1);
    expect(grif, 'гриф «Утверждаю» должен лежать внутри блока «Сведения»').toBeGreaterThan(info);
    expect(grif, 'гриф «Утверждаю» должен лежать внутри блока «Сведения», а не после «Деталей»').toBeLessThan(parts);
  });

  it('в списке деталей есть поиск по деталям', () => {
    expect(PANEL, 'поиск по деталям пропал — в длинном списке искомую не найти').toContain('Поиск детали');
    expect(PANEL, 'кнопки «Найти» нет — поиск нечем запустить').toContain('>Найти</Button>');
    expect(PANEL, 'поиск не фильтрует строки').toContain('setSearchQuery');
  });

  it('список деталей сортируется по шапке столбца', () => {
    expect(PANEL, 'сортировки по столбцам нет').toContain('toggleSortColumn');
    expect(PANEL, 'шапка столбца не кликабельна — сортировать нечем').toContain('onClick={() => toggleSortColumn(c.id)}');
  });

  it('столбец «Утиль» подкрашен фоном', () => {
    expect(PANEL, 'подсветки столбца утиля нет').toContain('isScrapColumn');
    expect(PANEL, 'подсветка утиля вешается не на тот столбец').toContain(
      "columnId === 'scrap_qty' || columnId === 'scrap_reason'",
    );
  });

  it('кнопки «Фото» в строках деталей больше нет (фото — у двигателя)', () => {
    expect(PANEL, 'кнопка «Фото» вернулась в строки деталей — строка снова втолстую').not.toContain('InventoryRowPhotos');
    expect(PANEL, 'кнопка «Фото» вернулась в строки деталей').not.toContain('renderRowExtra');
  });
});
