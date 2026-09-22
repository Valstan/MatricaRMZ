import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { arrivalPlacementLabel, arrivalPlacements } from '@matricarmz/shared';

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

describe('дубль номера двигателя: переход в существующую карточку — первый и самый заметный путь', () => {
  // Владелец 22.09.2026: гейт на создание дубля уже жёсткий, но оператор «всё равно создаёт
  // дубль». Единственный путь без побочных эффектов — открыть найденную карточку — стоял
  // третьим и был спрятан за словом «рекламация»; кто не по рекламации, тот выбирал
  // «повторный заезд» и заводил второй двигатель. Ассерты держат СВОЙСТВА этого выбора:
  // переход есть, он первый и он ничего не помечает.
  const PATHS_TITLE = 'Такой номер уже есть в базе. Что это за случай?';
  const OPEN_LABEL = 'Открыть существующий двигатель →';

  it('кнопка перехода существует и только открывает карточку — без флагов', () => {
    // Кнопка объявлена один раз (openExistingButton) и подставляется и в баннер, и в
    // выбор пути. Если она начнёт звать onChooseRepeatArrival/onChooseCollision, оператор
    // снова получит помеченную карточку вместо простого перехода — ровно то, от чего уходим.
    const defAt = CARD.indexOf('const openExistingButton');
    expect(defAt).toBeGreaterThan(-1);
    const labelAt = CARD.indexOf(OPEN_LABEL, defAt);
    expect(labelAt).toBeGreaterThan(-1);
    const decl = CARD.slice(defAt, labelAt);
    expect(decl).toContain('props.onOpenEngine?.(exact[0]!.id)');
    expect(decl).not.toContain('onChoose');
  });

  it('в выборе пути переход стоит раньше рекламации, повторного заезда и коллизии', () => {
    const pathsAt = CARD.indexOf(PATHS_TITLE);
    expect(pathsAt).toBeGreaterThan(-1);
    const paths = CARD.slice(pathsAt);
    const open = paths.indexOf('openExistingButton');
    expect(open).toBeGreaterThan(-1);
    for (const label of ['Открыть по рекламации', 'Это повторный заезд', 'Это другой двигатель']) {
      const at = paths.indexOf(label);
      expect(at).toBeGreaterThan(-1);
      expect(open).toBeLessThan(at);
    }
    // Выделение (emphasize) — у перехода, а не у «повторного заезда»: заметнее всех должен
    // быть путь, который не создаёт вторую карточку.
    const emphasizeAt = paths.indexOf('emphasize: true');
    expect(emphasizeAt).toBeGreaterThan(-1);
    expect(emphasizeAt).toBeLessThan(paths.indexOf('Открыть по рекламации'));
    expect(paths.split('emphasize: true').length - 1).toBe(1);
  });

  it('красный баннер точного совпадения ведёт в карточку и там, где выбора пути нет', () => {
    // Выбор пути показывается только при создании (canChoosePath). На уже сохранённой
    // карточке с тем же номером от перехода оставалась лишь мелкая подчёркнутая ссылка
    // «Открыть» в строке списка — её оператор не замечает.
    const pathsAt = CARD.indexOf(PATHS_TITLE);
    const banner = CARD.slice(CARD.indexOf('const openExistingButton'), pathsAt);
    const at = banner.indexOf('{openExistingButton}');
    expect(at).toBeGreaterThan(-1);
    // Баннерная кнопка скрыта при showPaths — иначе та же кнопка нарисовалась бы дважды
    // подряд, и «первый вариант выбора» перестал бы читаться как выбор.
    const guardAt = banner.lastIndexOf('!showPaths', at);
    expect(guardAt).toBeGreaterThan(-1);
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

// Карточка описывает себя МЕСТОМ в группе заездов, а не собственным флагом (владелец 22.09.2026:
// «в карточке старого заезда стоит неправильная логика: там написано "повторный заезд" и есть
// ссылки на прежние заезды, хотя это и есть тот самый прежний заезд»).
//
// `repeat_arrival_flag` образует группу, но ничего не говорит о месте в ней: он взведён и у
// третьего заезда, и у того, который давно стал архивом. Отсюда ассерты ниже — каждый держит
// СВОЙСТВО, а не написание.
describe('карточка двигателя знает, свежий это заезд или архивный', () => {
  it('бейдж не читает собственный флаг карточки', () => {
    // Ровно та ветка, на которую жаловался владелец: своим флагом карточка звала себя
    // «повторным заездом» независимо от того, есть ли заезд свежее.
    expect(CARD).not.toContain('🔁 Повторный заезд');
    expect(CARD).not.toMatch(/repeatArrivalFlag\s*\?\s*'/);
    // Коллизия номера — про другой физический двигатель, а не про заезды: остаётся своим флагом.
    expect(CARD).toContain('⚠ Коллизия номера');
    expect(CARD).toMatch(/\{numberCollisionFlag && \(/);
  });

  it('место и подпись берутся из общего правила shared', () => {
    // Своя копия правила в карточке разъехалась бы со списком и выпадающим выбором двигателя.
    expect(CARD).toContain('arrivalPlacements(');
    expect(CARD).toContain('arrivalPlacementLabel(');
    expect(CARD).not.toMatch(/'(?:Свежий|Архивный|свежий|архивный) заезд \(/);
  });

  it('состав группы приходит из подсказки о дублях, а не из нового запроса по парку', () => {
    // Карточка не должна тянуть весь список двигателей ради одной строки о себе.
    const memoAt = CARD.indexOf('const arrivalGroup = useMemo(');
    expect(memoAt).toBeGreaterThan(-1);
    const memo = CARD.slice(memoAt, CARD.indexOf('}, [', memoAt));
    expect(memo).toContain('dupMatches.exact');
    expect(memo).not.toContain('window.matrica');
    expect(CARD).not.toMatch(/engines\s*\.\s*list\b/);
  });

  it('у архивной карточки есть заметный переход на более свежий заезд', () => {
    const archivedAt = CARD.indexOf("arrivalGroup.placement.role === 'archived'");
    expect(archivedAt).toBeGreaterThan(-1);
    const branch = CARD.slice(archivedAt, CARD.indexOf('</div>', CARD.indexOf('свежий заезд →', archivedAt)));
    expect(branch).toContain('Есть более свежий заезд');
    // Переход — тем же пропом, что и прежняя ссылка: другого способа открыть карточку у страницы нет.
    expect(branch).toMatch(/onOpenEngine\?\.\(arrivalGroup\.current!?\.id\)/);
    // Ссылки «прежний заезд →» по previous_arrival_id больше нет: для архивной карточки
    // прежний заезд — она сама.
    expect(CARD).not.toContain('прежний заезд →');
  });

  it('свежая карточка показывает счётчик архивных заездов со ссылками', () => {
    expect(CARD).toContain('Архивных заездов:');
    const currentAt = CARD.indexOf("arrivalGroup.placement.role === 'current' && arrivalGroup.archived.length > 0");
    expect(currentAt).toBeGreaterThan(-1);
    const branch = CARD.slice(currentAt, currentAt + 1200);
    expect(branch).toMatch(/arrivalGroup\.archived\.map\(/);
    expect(branch).toMatch(/onOpenEngine\?\.\(o\.id\)/);
  });

  it('одиночный заезд блока не рисует', () => {
    // Весь блок — под группой; правило места не выдаёт места карточкам без группы,
    // и блока в обычной карточке не появляется.
    expect(CARD).toMatch(/\{arrivalGroup && \(/);
    expect(CARD).toContain('if (!selfPlacement) return null;');
    expect(arrivalPlacements([{ id: 'solo', engineNumber: 'X-1', isRepeatArrival: true }]).size).toBe(0);
  });

  it('подпись архивного заезда не называет его повторным', () => {
    // Свойство самой подписи: «повторный заезд» — служебный флаг, оператору он ничего
    // не говорит о том, где писать новые работы.
    const placements = arrivalPlacements([
      { id: 'old', engineNumber: '2Ж03АТ0479', arrivalDate: Date.UTC(2025, 4, 1) },
      { id: 'fresh', engineNumber: '2ж03ат0479', isRepeatArrival: true, arrivalDate: Date.UTC(2026, 8, 1) },
    ]);
    expect(placements.get('old')?.role).toBe('archived');
    expect(placements.get('fresh')?.role).toBe('current');
    expect(arrivalPlacementLabel(placements.get('old'))).toContain('архивный заезд');
    expect(arrivalPlacementLabel(placements.get('old'))).not.toContain('повторный');
  });
});
