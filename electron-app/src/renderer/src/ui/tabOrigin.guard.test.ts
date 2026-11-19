import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Возврат по месту открытия (владелец 08.11.2026): «после закрытия документа оператор
 * возвращается туда, откуда его открывал, а не в случайную вкладку».
 *
 * Прежнее правило — «вкладка слева»: закрыли карточку и улетели на соседнюю слева,
 * а это не обязательно та вкладка, из которой открывали (карточка встаёт справа от
 * активной, а активной могла быть другая карточка).
 *
 * Сторож — на инварианты, а не на написание: правило живёт в трёх местах, и сломать
 * любое из них можно молча.
 */
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const APP = src('./App.tsx');
const TABS_MODEL = src('../../../../../shared/src/domain/tabsModel.ts');
const UI_SHELL = src('../../../../../shared/src/domain/uiShellV2.ts');

describe('карточка помнит, откуда её открыли', () => {
  it('в домене у карточки есть поле источника', () => {
    expect(TABS_MODEL).toMatch(/export type CardTab = \{[\s\S]*?originTabId\?: string;/);
  });

  it('редьюсер записывает источник при открытии карточки', () => {
    expect(TABS_MODEL).toContain('const rawOrigin = action.originTabId?.trim() || state.activeId;');
    // Источником не может быть сама карточка: закрытие вернуло бы фокус на закрытую вкладку.
    expect(TABS_MODEL).toContain('rawOrigin === cardId');
  });

  it('фокус после закрытия идёт в источник, а не «в соседнюю слева»', () => {
    expect(TABS_MODEL).toMatch(
      /export function focusAfterClose[\s\S]*?closed\.originTabId[\s\S]*?return closed\.originTabId;/,
    );
    // Редьюсер закрытия спрашивает ту же функцию — иначе вкладка и фокус разъедутся.
    expect(TABS_MODEL).toMatch(/case 'CLOSE':[\s\S]*?const activeId = focusAfterClose\(state, target\.id\);/);
  });

  it('оболочка считает источник по списку раздела, а не по активной вкладке', () => {
    expect(APP).toContain('const cardOriginTabId = useCallback');
    // Открыли из списка раздела — возвращаемся в этот список (CARD_PARENT_TAB — та же
    // карта, что и у закрытия карточки по кнопке).
    expect(APP).toContain('CARD_PARENT_TAB[kind]');
    expect(APP).toContain('listTabId(parent)');
    // Открыли по ссылке из другой карточки — возвращаемся в активную вкладку.
    expect(APP).toContain('return state.activeId;');
    expect(APP).toContain('originTabId: cardOriginTabId(kind),');
  });

  it('источник переживает перезапуск: персист сессии его хранит', () => {
    expect(UI_SHELL).toMatch(/export type V2SessionCard = \{[\s\S]*?originTabId\?: string;/);
    expect(TABS_MODEL).toMatch(/export function sessionTabs[\s\S]*?originTabId: t\.originTabId/);
    expect(APP).toMatch(/originTabId: t\.card\.originTabId/);
  });
});
