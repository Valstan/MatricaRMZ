import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Левое меню планшета уезжает за край после паузы (владелец 23.11.2026).
//
// Ломается тихо: без класса «уехало» полоса просто стоит (места спису не досталось),
// без ручки возврата уехавшее меню уехало бы навсегда (на тач-экране нет ни мыши, ни
// наведения), а на десктопе тот же класс утащил бы привычное меню в сторону. Сторож
// держит все три вещи: правило, ручку возврата и то, что на десктопе ничего не едет.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const SHELL = src('./V3TabShell.tsx');
const CSS = src('./shellV3.css');
const APP = src('../App.tsx');
const HOOK = src('../hooks/useAutoHideRail.ts');
const RULE = src('../utils/railAutoHide.ts');

describe('левое меню планшета уезжает за край', () => {
  it('оболочка берёт правило из общего места, а не из своих настроек', () => {
    expect(SHELL).toContain('useAutoHideRail');
    expect(SHELL).toContain('enabled: railAutoHideEnabled');
    expect(HOOK).toContain('railAutoHideDecision');
    // Пауза живёт в правиле — в оболочке её числа быть не должно.
    expect(SHELL, 'пауза уезда продублирована в оболочке').not.toMatch(/setTimeout\([^)]*6000/);
    expect(RULE).toContain('RAIL_AUTO_HIDE_IDLE_MS');
  });

  it('уехавшая полоса помечена классом, а место под список освобождается', () => {
    expect(SHELL).toContain('v3-fav-rail--hidden');
    // Transform уводит полосу за край, margin — отдаёт её место списку. Без margin
    // список остался бы на прежних 112 px, и места под планшет не освободилось бы.
    expect(CSS).toMatch(/\.v3-fav-rail--hidden\s*\{[^}]*transform:\s*translateX/);
    expect(CSS).toMatch(/\.v3-fav-rail--hidden\s*\{[^}]*margin-left:/);
    expect(CSS).toMatch(/\.v3-fav-rail\s*\{[^}]*transition:[^}]*transform/);
  });

  it('ручка возврата есть и возвращает меню', () => {
    expect(SHELL).toContain('data-rail-handle="1"');
    expect(SHELL).toContain('railReveal()');
    expect(CSS).toMatch(/\.v3-rail-handle\s*\{[^}]*flex:\s*0 0/);
  });

  it('свайп от левого края тоже возвращает меню — на тач-экране наведения нет', () => {
    expect(SHELL).toContain("document.addEventListener('pointerdown', onEdge, true)");
    expect(SHELL).toContain('e.clientX > 32');
  });

  it('свернуть руками можно — авто-уезд ждёт паузы, а оператору нужно сейчас', () => {
    expect(SHELL).toContain('data-rail-collapse="1"');
    expect(SHELL).toContain('railHide()');
    expect(CSS).toMatch(/\.v3-rail-collapse\s*\{/);
  });

  it('на десктопе полоса не едет: флаг снимается планшетным режимом', () => {
    expect(APP).toContain('railAutoHide={tabletActive}');
    expect(SHELL).toContain("props.railAutoHide === true");
  });
});
