import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Планшетная версия (02.11.2026): две вещи, которые на планшете не работают.
//
// 1. «Перезапуск» в шапке — на планшете нет канала system.restart, кнопка
//    ничего не делала. На планшете её не показываем вовсе, а не прячем
//    «по-тихому»: предлагать оператору действие, которое не сработает, —
//    худший вариант.
//
// 2. Звёздочки разделов (избранное левой панели) — на планшете домен `sections`
//    не был зарегистрирован в мосте: запись возвращала «недоступно на планшете»,
//    оболочка откатывала выбор, и раздел в левый блок не попадал. Проверку
//    функциональную ведёт смоук-гейт моста на планшете
//    (android-app/src/core/bridge.smoke.test.ts).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const APP = src('./App.tsx');
const SHELL = src('./shellV3/V3TabShell.tsx');

describe('планшетная версия — кнопки, которые там не работают', () => {
  it('«Перезапуск» на планшете не предлагается', () => {
    expect(APP, 'перезапуск на планшете не работает — кнопку там показывать нельзя').toContain(
      'isAndroidPlatform() ? undefined : () => void restartApp()',
    );
  });

  it('кнопка в шапке рисуется только когда обработчик передан', () => {
    expect(SHELL, 'без обработчика кнопка не должна рисоваться').toContain('{props.onRestartApp ? (');
  });
});
