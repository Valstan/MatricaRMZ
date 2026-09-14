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
