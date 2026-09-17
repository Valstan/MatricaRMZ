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
    expect(ROW_END, 'закрытие ряда шапки не найдено — «в шапке или нет» измерить не по чему').toBeGreaterThan(TITLE_AT);
    expect(STATUS_AT, 'строка статуса не найдена — ответу проводки негде появиться').toBeGreaterThan(ROW_END);
  });

  it('ряд шапки переносится: на дефектовке в нём восемь элементов', () => {
    // Без переноса первой схлопывается распорка flex: 1, а дальше кнопки уезжают за край карточки
    // на 1024–1366 px — проводка становится недостижимой ровно на тех экранах, где она нужна.
    expect(LINES[TITLE_AT - 1], 'ряд шапки потерял перенос — кнопки уедут за край карточки на узком окне').toContain(
      "flexWrap: 'wrap'",
    );
  });

  for (const { marker, human, gate } of BUTTONS) {
    it(`кнопка проводки (${human}) стоит в ряду шапки, а не в хвосте`, () => {
      const at = labelAt(marker);
      expect(at, `кнопка проводки (${human}) оказалась выше заголовка панели — это уже не ряд шапки`).toBeGreaterThan(
        TITLE_AT,
      );
      expect(
        at,
        `кнопка проводки (${human}) вывалилась из ряда шапки: в хвосте её приходится искать прокруткой под таблицей деталей`,
      ).toBeLessThan(ROW_END);
      expect(
        at,
        `кнопка проводки (${human}) стоит ниже строки статуса — оператор нажмёт и не увидит ответа, он останется выше по экрану`,
      ).toBeLessThan(STATUS_AT);
    });

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
