import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Постоянные плашки «Ииваныч» и «ВЕРСТАК» внизу левой рельсы (владелец 21.10.2026).
//
// Требование звучит как «у всех, на всех машинах, на всех аккаунтах», и ломается оно тихо:
// достаточно положить плашки в избранное (личный профиль) — на новой машине их не будет,
// а у кого-то они удалятся вместе с чисткой избранного. Сторож держит три вещи: плашки
// стоят ВНЕ списка избранного, вкладки закрываемые, а подсказка Ииваныча — своя, не title.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const SHELL = src('./V3TabShell.tsx');
const CSS = src('./shellV3.css');
const APP = src('../App.tsx');

describe('постоянные плашки рельсы', () => {
  it('плашки стоят отдельным блоком, а не в избранном', () => {
    expect(SHELL).toContain('className="v3-fav-rail-builtins"');
    expect(SHELL).toContain('data-rail-builtin="1"');
    // Блок встроенных плашек не должен зависеть от личных избранных разделов.
    const builtins = SHELL.slice(SHELL.indexOf('className="v3-fav-rail-builtins"'));
    expect(builtins.slice(0, 1600), 'встроенные плашки начали зависеть от профиля').not.toContain('sectionFavorites');
  });

  it('плашка Ииваныча открывает Ииваныча, плашка ВЕРСТАКА — Верстак', () => {
    expect(SHELL).toContain("props.onAction('ai_chat')");
    expect(SHELL).toContain("props.onAction('chat')");
  });

  it('подсказка Ииваныча — свой элемент со словами владельца', () => {
    expect(SHELL).toContain('className="v3-fav-tip"');
    expect(SHELL).toContain('Спроси меня про что угодно, я знаю ответ!');
    expect(CSS).toMatch(/\.v3-fav-tip\s*\{[^}]*position:\s*absolute/);
    expect(CSS).toMatch(/\.v3-fav-card-ai:hover\s+\.v3-fav-tip/);
  });

  it('кремовый фон и красноватый оттенок у Ииваныча', () => {
    expect(CSS).toMatch(/\.v3-fav-card-workshop\s*\{[^}]*background:\s*#fdf3e4/);
    expect(CSS).toMatch(/\.v3-fav-card-ai\s*\{[^}]*background:\s*#fbeadf/);
    expect(SHELL).toContain('className="v3-fav-ai-rain"');
  });

  it('анимация уважает «меньше движения»', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.v3-fav-tip/);
    const RAIN = src('./MatrixRain.tsx');
    expect(RAIN).toContain("prefers-reduced-motion: reduce");
    expect(RAIN, 'кадры считаются и при скрытом окне').toContain("document.visibilityState === 'hidden'");
  });

  it('вкладки Ииваныча и Верстака закрываются, МЕНЮ — нет', () => {
    expect(APP).toContain("canClose: t.kind !== 'menu',");
    expect(APP, 'крестик у Ииваныча/Верстака снова не работает').not.toContain("t.kind !== 'chat' && t.kind !== 'ai_chat'");
  });
});
