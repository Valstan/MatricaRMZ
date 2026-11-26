import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Сторож окна приветствия (промт КАРМАНА #162).
 *
 * Проверяем свойства, а не вид: окно меняли уже дважды (телесуфлёр с автоскроллом,
 * который увозил текст, и маркеры `**` в тексте новинок). Тест держит три вещи:
 * текст виден сразу и никуда не едет, зачин жирный и без символов `*`, оформление
 * выбирает главный процесс (в рендерере своей случайности быть не должно — иначе
 * оформление прыгало бы при перезапуске программы).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_TSX = join(HERE, 'App.tsx');
const GLOBAL_CSS = join(HERE, 'global.css');
const DECOR_TSX = join(HERE, 'components', 'ReleaseWelcomeDecor.tsx');

const appSource = readFileSync(APP_TSX, 'utf8');
const css = readFileSync(GLOBAL_CSS, 'utf8');
const decorSource = readFileSync(DECOR_TSX, 'utf8');

/** Тело CSS-правила по селектору (пустая строка, если правила нет). */
function cssBlock(selector: string): string {
  const idx = css.indexOf(`${selector} {`);
  if (idx < 0) return '';
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return close < 0 ? '' : css.slice(open + 1, close);
}

/** Тело функции по имени (скобки считаются по балансу). */
function functionBody(source: string, name: string): string {
  const idx = source.indexOf(`function ${name}(`);
  if (idx < 0) return '';
  const open = source.indexOf('{', idx);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return '';
}

const welcomeModalBody = functionBody(appSource, 'renderReleaseWelcomeModal');

describe('окно приветствия: новинки видны сразу и не едут', () => {
  it('кегль новинок крупнее прежних 17px', () => {
    const block = cssBlock('.release-welcome-teleprompter-item--highlight');
    const size = Number(/font-size:\s*(\d+)px/.exec(block)?.[1] ?? '0');
    expect(size, 'кегль новинок должен быть больше прежних 17px').toBeGreaterThan(17);
  });

  it('автоскролла текста нет — оператор не ждёт, пока текст уедет', () => {
    expect(css).not.toContain('releaseWelcomeTeleprompterScroll');
    expect(css).not.toContain('release-welcome-teleprompter-track');
  });

  it('прокрутка осталась запасным путём — если текст не влез', () => {
    expect(cssBlock('.release-welcome-teleprompter-viewport')).toContain('overflow-y: auto');
  });
});

describe('окно приветствия: зачин жирный, символов * не видно', () => {
  it('строка новинок разбирается доменом, а не рисуется как есть', () => {
    expect(appSource).toContain('parseReleaseWelcomeLine');
    expect(appSource).toContain('release-welcome-line-lead');
  });

  it('текст новинок не рисуется как есть', () => {
    // Прежний код рисовал строку целиком: `<span>{item.text}</span>` — с маркерами `**`.
    expect(welcomeModalBody).not.toContain('<span>{item.text}</span>');
    expect(welcomeModalBody).toContain('renderReleaseWelcomeLine');
    expect(appSource).toContain('<strong className="release-welcome-line-lead">');
  });
});

describe('окно приветствия: оформление выбирает главный процесс', () => {
  it('вариант приходит из ответа IPC, а не выбирается в рендерере', () => {
    expect(appSource).toContain('variant: r.variant');
    expect(appSource).toContain('release-welcome-overlay--${releaseWelcomeUi.variant}');
  });

  it('в оформлении нет своей случайности', () => {
    expect(decorSource).not.toContain('Math.random');
  });

  it('три варианта оформления живут в программе', () => {
    for (const variant of ['aurora', 'vines', 'snow']) {
      expect(decorSource).toContain(`release-welcome-decor--${variant}`);
    }
    expect(css).toContain('.release-welcome-overlay--vines');
    expect(css).toContain('.release-welcome-overlay--snow');
  });
});

describe('окно приветствия: снежное оформление', () => {
  it('логотип лежит слоем ниже снежинок', () => {
    expect(decorSource.indexOf('release-welcome-logo')).toBeLessThan(
      decorSource.indexOf('release-welcome-flakes'),
    );
  });

  it('сугроб растёт и держится, а не исчезает', () => {
    const block = cssBlock('.release-welcome-snowdrift');
    expect(block).toContain('animation:');
    expect(block).toContain('forwards');
  });

  it('без файла логотипа окно рисует заглушку, а не пустоту', () => {
    expect(decorSource).toContain('release-welcome-logo-placeholder');
  });
});

describe('окно приветствия: детали завода берут цвет оформления', () => {
  it('каждая деталь рисуется через currentColor — иначе гайка уходит в чёрный', () => {
    // Деталь без currentColor рисуется зашитым цветом и выбивается из палитры оформления:
    // гайка без fill="currentColor" была чёрной и не брала ни зелёный, ни красный.
    const cases = [...decorSource.matchAll(/case '(\w+)':\s*\n\s*return \(\s*\n([\s\S]*?)\n\s*\);/g)];
    expect(cases.length, 'в renderEnginePartSvg должно быть 8 деталей завода').toBe(8);
    for (const [, kind, body] of cases) {
      expect(body, `деталь ${kind} должна брать цвет оформления`).toContain('currentColor');
    }
  });
});

describe('окно приветствия: prefers-reduced-motion выключает все три оформления', () => {
  it('новые анимации попали в блок reduced-motion', () => {
    const idx = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(idx).toBeGreaterThan(-1);
    const block = css.slice(idx, idx + 2000);
    for (const selector of [
      '.release-welcome-vine',
      '.release-welcome-flake',
      '.release-welcome-snowdrift',
      '.release-welcome-ornament',
      '.release-welcome-logo',
    ]) {
      expect(block, selector).toContain(selector);
    }
  });
});
