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
const ANDROID_SHIM = src('../../../../../android-app/src/bridge/shim.ts');
const EMPLOYEE_IPC = src('../../../main/ipc/register/employees.ts');
const PRELOAD = src('../../../preload/index.ts');
const PP_PAGE = src('./pages/ProductionProgramPage.tsx');

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
  it('раздел есть в операторском пресете — иначе его срежет пресет', () => {
    // Промт КАРМАНА #142: рамки разделов для Android больше нет (разделы
    // режет только право и членство в разделе), но операторский пресет — если
    // его включил оператор — Production Program в себе держать должен.
    expect(tabList(TABS, 'TABLET_OPERATOR_TABS')).toContain('production_program');
  });

  it('рамки разделов по платформе больше нет — планшет показывает те же разделы', () => {
    // Прежде эффективное меню Android = ANDROID_TABS ∩ TABLET_OPERATOR_TABS.
    // Теперь платформенной рамки нет вовсе: раздел на планшете режут только
    // право и членство в разделе — те же, что на компьютере.
    expect(tabList(TABS, 'ANDROID_TABS'), 'рамка разделов для Android должна быть убрана').toEqual([]);
    expect(APP, 'меню всё ещё режется по платформе').not.toContain('ANDROID_TABS.includes');
    expect(APP, 'меню не должно зависеть от платформы').not.toMatch(/isAndroidPlatform\(\)\s*\?[^;]*filter/);
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

  it('раздел клиента попадает в операторский пресет — иначе его срежет пресет', () => {
    // Промт КАРМАНА #142: пресет остался отдельной сущностью (его включает
    // оператор), но платформенной рамки больше нет. Значит проверяем одно:
    // раздел производственной программы в пресете есть.
    const operatorTabs = tabList(TABS, 'TABLET_OPERATOR_TABS');
    expect(operatorTabs).toContain('production_program');
  });
});

/**
 * Правда вместо лжи (промт КАРМАНА #84, разбор планшета 25.11.2026).
 *
 * Разбор показал: на планшете раздел срезал гейт ЧЛЕНСТВА, а клиент смотрел
 * membership в замороженное EAV-зеркало `section_access` — там разделов, выданных
 * после миграции 0103, нет ни у кого. Ответ такого источника не авторитетен, и
 * IPC-гейт уже говорит «данные о доступах не обновлены (нужен синх)», а меню —
 * по-старому «раздел не выдан вашей учётной записи». Одно говорит правду, второе
 * врёт: оператор (и админ, к которому он придёт) ищет несуществующую проблему
 * с выдачей прав.
 *
 * Теперь источник доезжает до меню — и причина называется по источнику.
 */
describe('причина среза называет источник, а не выдумывает выдачу прав', () => {
  it('клиент отдаёт источник membership отдельным каналом', () => {
    expect(EMPLOYEE_IPC, 'канал источника membership не зарегистрирован').toContain('access:sections:self:source');
    expect(EMPLOYEE_IPC, 'источник берётся тем же read\'ом, что и сам membership').toContain(
      'getSectionMembershipByLoginWithSource',
    );
    expect(PRELOAD, 'preload не отдаёт источник в renderer').toContain('sectionsSelfSource');
  });

  it('планшетный шим отдаёт источник тоже — иначе renderer упадёт на его вызове', () => {
    expect(ANDROID_SHIM, 'шим планшета не отвечает на чтение источника membership').toContain(
      'sectionsSelfSource',
    );
  });

  it('меню знает источник и говорит по нему разные вещи', () => {
    expect(APP, 'меню не читает источник membership').toContain('sectionsSelfSource');
    expect(APP, 'источник не передан в расчёт причины').toContain('membershipSource: sectionMembershipSource');
    expect(REASON_UTIL, 'нет отдельной причины для слепого источника').toContain('no_membership_stale');
    expect(REASON_UTIL, 'в тексте нет «нужен синх»').toContain('нужен синх');
  });

  it('права при этом не расширяются: раздел остаётся закрытым, меняется только объяснение', () => {
    // Никакого «открыть всё»: причина — текст, а не обход гейта.
    expect(REASON_UTIL, 'причина превратилась в доступ').not.toMatch(/allowedByMembership\s*[:=]\s*true/);
    expect(APP, 'меню не стало fail-open при слепом источнике').not.toContain(
      'membershipSource === \'legacy_eav\' ? availableTabs',
    );
  });
});

/**
 * Плишка — это вход в СПИСОК производственных программ (промт КАРМАНА #84,
 * п.2: «быстрый переход в список производственных программ»).
 *
 * Ломается тихо: плашка может открыть пустую вкладку (раздел не отрисован) или
 * не открыть ничего. Сторож держит цепочку: плашка → раздел → страница ПП со
 * списком программ.
 */
describe('плишка ПП ведёт в список производственных программ', () => {
  it('клик по плашке открывает раздел, а не пустую вкладку', () => {
    expect(SHELL, 'плашка ПП не зовёт меню-раздел').toContain("props.onMenuTab('production_program')");
    expect(APP, 'раздел ПП не отрисован страницей').toContain("t === 'production_program'");
    expect(APP, 'страница ПП не подключена').toContain('<ProductionProgramPage');
  });

  it('страница ПП показывает список программ (плашки слева) — это и есть вход', () => {
    expect(PP_PAGE, 'на странице нет списка производственных программ').toContain('programs.map');
    expect(PP_PAGE, 'программа не выбирается из списка').toContain('selectProgram(p.id)');
  });
});
