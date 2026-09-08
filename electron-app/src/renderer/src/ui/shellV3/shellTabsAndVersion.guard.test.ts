import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Четыре правки шелла (владелец 08.09.2026) рвутся молча, и ни одну не видят типы:
//  1) вкладка снова становится закрываемой — крестик у Меню/Верстака/ИИваныча означает
//     «спрятать до перезахода», чего оператор не ожидает;
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

describe('незакрываемые вкладки', () => {
  it('Меню, Верстак и ИИваныч закрыть нельзя', () => {
    expect(APP).toContain("canClose: t.kind !== 'menu' && t.kind !== 'chat' && t.kind !== 'ai_chat'");
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
