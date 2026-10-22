import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Постоянные плашки «ИИваныч» и «ВЕРСТАК» внизу левой панели (владелец 21.10.2026,
// правки 22.10.2026: плашки крупнее, дождь — застывшая картинка, имя с двумя «И»).
//
// Требование звучит как «у всех, на всех машинах, на всех аккаунтах», и ломается оно тихо:
// достаточно положить плашки в избранное (личный профиль) — на новой машине их не будет,
// а у кого-то они удалятся вместе с чисткой избранного. Сторож держит четыре вещи: плашки
// стоят ВНЕ списка избранного, подсказка ИИваныча — своя, дождь не двигается, имя пишется
// так, как решил владелец.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const SHELL = src('./V3TabShell.tsx');
const CSS = src('./shellV3.css');
const APP = src('../App.tsx');

describe('постоянные плашки левой панели', () => {
  it('плашки стоят отдельным блоком, а не в избранном', () => {
    expect(SHELL).toContain('className="v3-fav-rail-builtins"');
    expect(SHELL).toContain('data-rail-builtin="1"');
    // Блок встроенных плашек не должен зависеть от личных избранных разделов.
    const builtins = SHELL.slice(SHELL.indexOf('className="v3-fav-rail-builtins"'));
    expect(builtins.slice(0, 1600), 'встроенные плашки начали зависеть от профиля').not.toContain('sectionFavorites');
  });

  it('плашка ИИваныча открывает ИИваныча, плашка ВЕРСТАКА — Верстак', () => {
    expect(SHELL).toContain("props.onAction('ai_chat')");
    expect(SHELL).toContain("props.onAction('chat')");
  });

  it('имя на плашке — ИИваныч, с двумя заглавными «И» (владелец 22.10.2026)', () => {
    expect(SHELL).toContain('>ИИваныч<');
    expect(SHELL, 'старое написание вернулось на плашку').not.toContain('>Ииваныч<');
  });

  it('подсказка ИИваныча — свой элемент со словами владельца', () => {
    expect(SHELL).toContain('className="v3-fav-tip"');
    expect(SHELL).toContain('Спроси меня про что угодно, я знаю ответ!');
    expect(CSS).toMatch(/\.v3-fav-tip\s*\{[^}]*position:\s*absolute/);
    expect(CSS).toMatch(/\.v3-fav-card-ai:hover\s+\.v3-fav-tip/);
  });

  it('плашки — квадраты одинакового размера (владелец 22.10.2026)', () => {
    // Первая правка сузила панель, но оставила высоту по содержимому → полоски;
    // вторая перегнула в высокие прямоугольники. Квадрат — то, что просили.
    expect(CSS).toMatch(/\.v3-fav-card\s*\{[^}]*aspect-ratio:\s*1 \/ 1;/);
    expect(CSS, 'постоянные плашки снова выбиваются размером').not.toMatch(/\.v3-fav-rail-builtins\s+\.v3-fav-card\s*\{/);
  });

  it('кремовый фон и красноватый оттенок у ИИваныча', () => {
    expect(CSS).toMatch(/\.v3-fav-card-workshop\s*\{[^}]*background:\s*#fdf3e4/);
    expect(CSS).toMatch(/\.v3-fav-card-ai\s*\{[^}]*background:\s*#fbeadf/);
    expect(SHELL).toContain('className="v3-fav-ai-rain"');
  });

  it('дождь — застывший кадр картинкой, а не бегущий canvas (владелец 22.10.2026)', () => {
    // «Просто фотография, чтобы она не двигалась»: анимация снята целиком, вместе с ней
    // ушёл и её сторож — бегущего дождя в коде больше нет, вернуть его молча нечем.
    expect(CSS).toMatch(/\.v3-fav-ai-rain\s*\{[^}]*background-image:[^;]*iiivanych-rain\.svg/);
    expect(CSS, 'дождь снова начал двигаться').not.toMatch(/\.v3-fav-ai-rain\s*\{[^}]*animation:/);
    expect(SHELL).not.toContain('MatrixRain');
    expect(existsSync(fileURLToPath(new URL('./MatrixRain.tsx', import.meta.url))), 'canvas-дождь вернулся').toBe(false);
    const svg = src('../../assets/iiivanych-rain.svg');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg, 'кадр потерял кириллические глифы').toMatch(/<text[^>]*>[А-Я0-9]<\/text>/);
  });

  it('вкладки ИИваныча и Верстака закрываются, МЕНЮ — нет', () => {
    expect(APP).toContain("canClose: t.kind !== 'menu',");
    expect(APP, 'крестик у ИИваныча/Верстака снова не работает').not.toContain("t.kind !== 'chat' && t.kind !== 'ai_chat'");
  });
});
