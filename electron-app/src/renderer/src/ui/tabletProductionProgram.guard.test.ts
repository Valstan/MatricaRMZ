import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Производственная программа на планшете (промт КАРМАНА #70, п.4 и п.5):
 * раздел открывается на планшете, а его значок — в левой вертикальной полосе.
 *
 * Ломается тихо: раздел есть в коде, но на планшете его срезает один из двух
 * фильтров меню (эффективное меню Android = ANDROID_TABS ∩ TABLET_OPERATOR_TABS),
 * а страница без зарегистрированного домена открывается пустой. Сторож держит
 * оба фильтра, оба домена моста и постоянную плашку в левой полосе.
 */
const src = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');

const TABS = src('./layout/Tabs.tsx');
const SHELL = src('./shellV3/V3TabShell.tsx');
const APP = src('./App.tsx');
const REASON_UTIL = src('./utils/sectionGateReason.ts');
const GLOBAL_CSS = src('./global.css');
const IPC_WIRING = src('../../../../../android-app/src/core/ipcWiring.ts');
const ANDROID_MAIN = src('../../../../../android-app/src/main.tsx');

/** Список из объявления массива по имени. */
function tabList(source: string, name: string): string[] {
  const decl = source.indexOf(`export const ${name}`);
  if (decl < 0) return [];
  const assign = source.indexOf('=', decl);
  const open = source.indexOf('[', assign);
  const close = source.indexOf(']', open);
  return source
    .slice(open, close)
    .split('\n')
    .map((line) => line.trim().replace(/,$/, '').replace(/^'|'$/g, ''))
    .filter((line) => line.length > 0 && !line.startsWith('//'));
}

describe('производственная программа на планшете', () => {
  it('раздел есть в обоих фильтрах меню — иначе его срежет один из них', () => {
    expect(tabList(TABS, 'ANDROID_TABS'), 'раздел ПП не попал в ANDROID_TABS').toContain('production_program');
    expect(tabList(TABS, 'TABLET_OPERATOR_TABS'), 'раздел ПП не попал в TABLET_OPERATOR_TABS').toContain(
      'production_program',
    );
  });

  it('домены ПП и «Договоры» зарегистрированы в мосте планшета', () => {
    expect(IPC_WIRING, 'домен ПП не зарегистрирован на планшете — страница откроется пустой').toContain(
      'registerProductionProgramIpc(ctx)',
    );
    expect(IPC_WIRING, 'домен «Договоры» не зарегистрирован — «№ в договоре» будет пустым').toContain(
      'registerContractsIpc(ctx)',
    );
  });

  it('значок ПП — постоянная плашка в левой вертикальной полосе', () => {
    const builtins = SHELL.slice(SHELL.indexOf('className="v3-fav-rail-builtins"'));
    expect(builtins.slice(0, 3000), 'плашки ПП нет в постоянном блоке левой полосы').toContain(
      "props.onMenuTab('production_program')",
    );
    expect(builtins.slice(0, 3000), 'плашка ПП поставлена в избранное (личный профиль)').not.toContain(
      'sectionFavorites',
    );
  });

  it('на планшете не показываются кнопки, которые там не работают', () => {
    expect(ANDROID_MAIN, 'признак планшета в разметке не выставлен').toContain(
      "document.documentElement.dataset.platform = 'android'",
    );
    expect(GLOBAL_CSS, 'печать ПП на планшете не спрятана').toContain("[data-pp-action='print']");
    expect(GLOBAL_CSS, 'выгрузка в Word на планшете не спрятана').toContain("[data-pp-action='word']");
    expect(GLOBAL_CSS, 'выгрузка в Excel на планшете не спрятана').toContain("[data-pp-action='excel']");
    expect(GLOBAL_CSS, 'правило спрятано не только для Android — десктоп потеряет выгрузку').toContain(
      ":root[data-platform='android']",
    );
  });
});

/**
 * Раздел не должен исчезать молча (промт КАРМАНА #84, владелец 24.11.2026).
 *
 * Претензия: «на планшете так и не появилась в меню “Производственная программа”».
 * Три фильтра режут раздел по отдельности (право → членство в разделе → пресет
 * клиента), и оператор видел только следствие: раздела нет, и почему — неизвестно.
 * Теперь причина считается и говорится словами.
 */
describe('раздел не исчезает молча', () => {
  it('причина среза считается по трём фильтрам и переводится в слова', () => {
    expect(APP, 'причина среза не считается').toContain('sectionGateReason(');
    expect(APP, 'причина не показывается оператору').toContain('sectionGateReasonText(');
    expect(REASON_UTIL, 'логика причины вынесена в отдельный модуль').toContain('export function sectionGateReason');
    expect(REASON_UTIL, 'нет текста про «не выдан учётной записи»').toContain('не выдан вашей учётной записи');
  });

  it('клик по срезанному разделу объясняет причину, а не молчит', () => {
    expect(APP, 'срезанный раздел по-прежнему игнорируется молча').toContain('notifyOperator');
    expect(APP, 'в уведомлении нет причины среза').toContain('не открывается');
  });

  it('плашка ПП остаётся, когда раздел срезан, и говорит, чем срезан', () => {
    expect(SHELL, 'плашка не знает о причине среза').toContain('sectionGateNotes');
    expect(SHELL, 'плашка прячется вместе с разделом').toContain('v3-fav-card-cut');
    expect(APP, 'оболочка не получает причины среза').toContain('sectionGateNotes={sectionGateNotes}');
  });

  it('раздел клиента попадает и в пресет рамки, и в пресет оператора — иначе его срежет пересечение', () => {
    const androidTabs = tabList(TABS, 'ANDROID_TABS');
    const operatorTabs = tabList(TABS, 'TABLET_OPERATOR_TABS');
    for (const tab of androidTabs) {
      expect(operatorTabs, `раздел ${tab} есть в ANDROID_TABS, но его нет в TABLET_OPERATOR_TABS`).toContain(tab);
    }
  });
});
