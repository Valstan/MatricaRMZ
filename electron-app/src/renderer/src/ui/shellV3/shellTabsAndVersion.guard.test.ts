import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Четыре правки шелла (владелец 08.09.2026) рвутся молча, и ни одну не видят типы:
//  1) вкладка МЕНЮ снова становится закрываемой — закрытая, она возвращалась только при
//     следующем входе в программу, чего оператор не ожидает (Верстак и Ииваныч с 21.10.2026
//     закрывать МОЖНО — к ним ведут постоянные плашки в левой рельсе);
//  2) колокольчик отвязывается от счётчика — о сообщении узнают, только зайдя в чат;
//  3) отступ плитки Верстака уезжает обратно на 10px, и вторая строка подписи режется;
//  4) версия в меню перестаёт спрашиваться у моста — на планшете её негде увидеть.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const SHELL = src('./V3TabShell.tsx');
const SHELL_CSS = src('./shellV3.css');
const APP = src('../App.tsx');
const PANEL = src('../shellV2/ButtonPanel.tsx');
const PANEL_CSS = src('../shellV2/buttonPanel.css');
const DESKTOP = src('../components/DesktopPane.tsx');

describe('закрываемость вкладок', () => {
  it('Меню закрыть нельзя, Верстак и Ииваныч — можно', () => {
    expect(APP).toContain("canClose: t.kind !== 'menu',");
  });

  it('крестик рисуется строго по признаку закрываемости', () => {
    expect(SHELL).toContain('{tab.canClose && (');
  });
});

describe('колокольчик непрочитанных', () => {
  it('висит на вкладке Верстака и показывает число', () => {
    expect(SHELL).toContain("tab.kind === 'chat' && Number(props.chatUnread ?? 0) > 0");
    expect(SHELL).toContain('data-chat-unread');
  });

  it('питается уже существующим счётчиком, а не своим опросом', () => {
    expect(APP).toContain('chatUnread={chatUnreadTotal}');
  });

  it('дёргается редко и уважает системный отказ от анимации', () => {
    expect(SHELL_CSS).toContain('@keyframes v3-bell-shake');
    expect(SHELL_CSS, 'постоянная анимация перестаёт замечаться').toContain('animation: v3-bell-shake 10s ease-in-out infinite');
    expect(SHELL_CSS).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('подписи ярлыков Верстака', () => {
  it('отступ соответствует расчёту высоты плитки — иначе вторая строка режется', () => {
    expect(DESKTOP).toContain("padding: '7px 4px'");
  });

  it('две строки целиком, полное имя — в подсказке', () => {
    expect(DESKTOP).toContain('WebkitLineClamp: 2');
    expect(DESKTOP).toContain('title={s.link != null ? `${s.label}');
  });

  it('многоточие рисует сам кламп: textOverflow обрезал бы КАЖДУЮ строку', () => {
    // Поймано на стенде 08.09.2026: «Скрипты обслуживания» превращалось в «Скрипты… обслуживания».
    const labelBlock = DESKTOP.slice(DESKTOP.indexOf('WebkitLineClamp: 2') - 400, DESKTOP.indexOf('WebkitLineClamp: 2'));
    expect(labelBlock).not.toContain("textOverflow: 'ellipsis'");
  });
});

describe('вкладки — постоянной ширины (владелец 22.10.2026)', () => {
  it('ширина задана числом, а не содержимым: приписки не дёргают полосу', () => {
    const tabRule = SHELL_CSS.slice(SHELL_CSS.indexOf('\n.v3-tab {'), SHELL_CSS.indexOf('border:', SHELL_CSS.indexOf('\n.v3-tab {')));
    // 138px было до возврата звезды на вкладку (13.11.2026): под звезду место нужно,
    // иначе название вкладки режется до «Двиг…».
    expect(tabRule).toContain('flex: 0 0 160px');
    expect(tabRule).toContain('width: 160px');
    expect(tabRule, 'вкладка снова сжимается по содержимому').not.toContain('flex: 0 1 auto');
  });

  it('МЕНЮ не растягивается на фиксированную ширину', () => {
    const menuRule = SHELL_CSS.slice(SHELL_CSS.indexOf('.v3-tab-menu {'));
    expect(menuRule.slice(0, 120)).toContain('width: auto');
  });

  it('кнопки «Заметка разработчику» в шапке нет (владелец 22.10.2026)', () => {
    expect(SHELL).not.toContain('data-program-feedback-btn');
    expect(SHELL).not.toContain('Заметка разработчику');
    // Вход остался в МЕНЮ («Правка программы») — иначе фича потеряла бы последнюю дверь на планшете.
    expect(src('../shellV2/menuActions.ts')).toContain('Правка программы');
  });
});

describe('кнопки вкладок в шапке (владелец 13.11.2026)', () => {
  it('подпись тянется, текст режется многоточием — звезда и крестик у правого края', () => {
    // «Кнопка закрытия как-то странно смещена влево от края, как будто там что-то должно
    // быть, но там пусто»: подпись не занимала всю вкладку, и крестик висел по середине.
    const labelRule = SHELL_CSS.slice(
      SHELL_CSS.indexOf('\n.v3-tab-label {'),
      SHELL_CSS.indexOf('}', SHELL_CSS.indexOf('\n.v3-tab-label {')),
    );
    expect(labelRule).toContain('flex: 1 1 auto');
    expect(SHELL_CSS).toMatch(/\.v3-tab-text\s*\{[^}]*text-overflow:\s*ellipsis/);
  });

  it('звезда на вкладке — между названием и крестиком', () => {
    expect(SHELL).toContain('v3-tab-text');
    expect(SHELL).toContain('v3-tab-star');
    expect(SHELL).toContain('FavoriteStarButton');
  });

  it('звезда на вкладке без обрамления: пустая — серая, активная — золотая', () => {
    // «звездочку сделай на пустом месте без обрамления, неактивированная звездочка внутри
    // пустотелая, а активированная — желтая».
    const star = src('../components/FavoriteStarButton.tsx');
    expect(star).toContain("variant?: 'framed' | 'plain'");
    expect(star).toContain('data-fav-variant');
    expect(SHELL).toContain('variant="plain"');
  });

  it('крестик вкладки — кнопка с серым фоном, чтобы по нему было видно, куда целиться', () => {
    const closeRule = SHELL_CSS.slice(
      SHELL_CSS.indexOf('\n.v3-tab-close {'),
      SHELL_CSS.indexOf('}', SHELL_CSS.indexOf('\n.v3-tab-close {')),
    );
    expect(closeRule).toMatch(/background:\s*rgba\(/);
  });
});

describe('версия программы в меню', () => {
  it('первая строка меню спрашивает версию у моста', () => {
    expect(PANEL).toContain('window.matrica.app.version()');
    expect(PANEL).toContain('formatAppVersionLabel(r.version)');
    expect(PANEL).toContain('data-app-version');
    expect(PANEL_CSS).toContain('.v2-app-version');
  });

  it('меню работает и без версии — она справочная строка, а не условие показа', () => {
    expect(PANEL).toContain("appVersionLabel || 'Версия: —'");
  });
});
