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
    ['props.canCreateWorkOrder', 'ремонтный наряд и «Провести дефектовку»'],
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
