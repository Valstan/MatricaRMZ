import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож вкладок карточки двигателя «Акт комплектности» / «Акт дефектовки» (D1, план autumn-2026).
//
// Прежняя вкладка «Детали и акты» разрезана на две, но лист деталей под ними остался ОДИН:
// это одна строка operations со stage `engine_inventory`, и её meta_json пишется полной
// заменой (checklistService.ts) — без merge и без ревизий. Отсюда все ассерты ниже:
//
//  * два экземпляра панели = тихая потеря данных (у каждого свой answers; кто сохранился
//    вторым, тот и затёр первого) — ни типы, ни линт, ни один другой тест этого не увидят;
//  * условный рендер вместо `hidden` = размонтирование панели на каждом переключении вкладки
//    (сброс несохранённых правок, повторная загрузка, повторный resync по марке);
//  * инлайновый `display` на скрываемой обёртке перебивает `hidden`, и «скрытая» вкладка
//    остаётся на экране (грабля M78 в docs/GOTCHAS.md).
//
// Каждый ассерт держит СВОЙСТВО кода, а не его написание.

function src(rel: string): string {
  // Рабочая копия в CRLF (core.autocrlf=true) — нормализуем, чтобы ассерты не зависели
  // от того, на какой машине сделан checkout.
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const CARD = src('./EngineDetailsPage.tsx');
const APP = src('../App.tsx');

describe('акт-вкладки карточки двигателя: одна панель, скрытие вместо размонтирования', () => {
  it('панель ремонтного листа на карточке ровно одна', () => {
    // Главный риск D1. Лист деталей общий для обоих актов, а сохранение идёт полной
    // заменой meta_json: второй экземпляр панели со своим answers молча затёр бы правки
    // первого (заполнил комиссию на комплектности → поставил утиль на дефектовке →
    // комиссии нет). Красного не будет больше нигде — только здесь.
    expect(CARD.split('<RepairChecklistPanel').length - 1).toBe(1);
  });

  it('обе акт-вкладки показывают одну и ту же обёртку, скрытую через hidden', () => {
    // Обёртка одна: два соседних <div hidden> с панелью в каждом — это разные позиции
    // в дереве React, то есть размонтирование панели при каждом переключении вкладки.
    expect(CARD.split('data-card-tab="acts"').length - 1).toBe(1);
    // Скрытие атрибутом, а не условным рендером.
    expect(CARD).toContain("hidden={activeTab !== 'completeness' && activeTab !== 'defect'}");
    expect(CARD).toMatch(/data-card-tab="acts"[\s\S]{0,400}<RepairChecklistPanel/);
    // Ветка вида `{activeTab === 'completeness' && <…>}` вернула бы размонтирование.
    expect(CARD).not.toContain("{activeTab === 'completeness' &&");
    expect(CARD).not.toContain("{activeTab === 'defect' &&");
    // Условие перед обёрткой — только право на операции: дописанное сюда `activeTab === …`
    // снова превратило бы hidden в условный рендер, и атрибут выше остался бы декорацией.
    const gateAt = CARD.lastIndexOf('{props.canViewOperations', CARD.indexOf('data-card-tab="acts"'));
    expect(gateAt).toBeGreaterThan(-1);
    expect(CARD.slice(gateAt, CARD.indexOf('data-card-tab="acts"'))).not.toContain('activeTab');
  });

  it('на скрываемой обёртке нет инлайнового display', () => {
    // M78: инлайновый display перебивает атрибут hidden, и «скрытая» вкладка остаётся
    // видимой. Раскладку вешаем на дочерний узел внутри обёртки, а не на неё саму.
    const attrAt = CARD.indexOf('data-card-tab="acts"');
    expect(attrAt).toBeGreaterThan(-1);
    const openTagAt = CARD.lastIndexOf('<div', attrAt);
    const panelAt = CARD.indexOf('<RepairChecklistPanel', attrAt);
    expect(openTagAt).toBeGreaterThan(-1);
    expect(panelAt).toBeGreaterThan(openTagAt);
    expect(CARD.slice(openTagAt, panelAt)).not.toContain('display');
  });

  it('вид акта выводится из активной вкладки, а не хранится отдельно', () => {
    // Панель одна, значит вид акта — чисто рендерная величина: проп, вычисленный из
    // activeTab. Своё состояние (и тем более своя пара вкладок внутри панели) развело бы
    // ярлык вкладки и заголовок акта.
    expect(CARD).toContain("actView={activeTab === 'defect' ? 'defect' : 'completeness'}");
    expect(CARD).not.toContain('setActView');
  });
});

describe('право на операции закрывает акт-вкладки списком, а не перечислением', () => {
  it('фильтр вкладок ходит через константу, а не сравнивает ключи по одному', () => {
    // Перечисление `t.key !== 'completeness' && t.key !== 'defect' && …` тихо ломается
    // забытым ключом: новая вкладка под правом на операции откроется всем.
    expect(CARD).toContain('OPERATIONS_ONLY_TABS.has(t.key)');
    expect(CARD).not.toMatch(/t\.key !== '/);
    // Сама обёртка акт-вкладок тоже под правом, а не только ярлыки.
    expect(CARD).toMatch(/\{props\.canViewOperations && \(\s*<div[^>]*data-card-tab="acts"/);
  });

  it('в константе ровно три ключа, и все они — настоящие вкладки', () => {
    const decl = CARD.match(/const OPERATIONS_ONLY_TABS = new Set<EngineCardTab>\(\[([^\]]*)\]\)/);
    expect(decl).not.toBeNull();
    const keys = [...(decl?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(keys.slice().sort()).toEqual(['completeness', 'defect', 'history'].sort());
    // Ключ, которого нет в списке вкладок, спрятал бы вкладку от всех сразу.
    for (const key of keys) expect(CARD).toContain(`{ key: '${key}', label:`);
  });
});

describe('старый ключ вкладки «Детали и акты» выведен из обращения', () => {
  it('в объединении вкладок карточки его нет, а два акта есть', () => {
    const union = CARD.match(/export type EngineCardTab = [^;]*;/)?.[0] ?? '';
    expect(union).toContain("'completeness'");
    expect(union).toContain("'defect'");
    expect(union).not.toContain("'details'");
  });

  it('ни карточка, ни App им больше не адресуют вкладку', () => {
    // Остаток `initialTab: 'details'` где-нибудь в App открывал бы карточку на вкладке,
    // которой нет: activeTab не совпал бы ни с одной обёрткой и все они были бы скрыты.
    for (const text of [CARD, APP]) {
      expect(text).not.toMatch(/(?:activeTab|initialTab|engineInitialTab|key)\s*(?:===|!==|[:=])\s*'details'/);
      // И ни одного «details» рядом с типом вкладок: `useState<EngineCardTab>('details')`
      // или аннотированная переменная прошли бы мимо шаблона выше.
      expect(text).not.toMatch(/EngineCardTab[^\n]{0,80}'details'/);
      expect(text).not.toContain('data-card-tab="details"');
    }
  });

  it('App берёт тип вкладок из карточки, а не переписывает объединение своими руками', () => {
    // Три рукописные копии `'main' | 'details' | …` разъезжались молча: карточка про
    // новый ключ знала, App — нет.
    expect(APP).toContain("import type { EngineCardTab } from './pages/EngineDetailsPage.js';");
    expect(APP).not.toMatch(/'main'\s*\|\s*'/);
  });
});
