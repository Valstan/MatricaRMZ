import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Планшетная версия: кнопки, которые там работают (промт КАРМАНА #142).
//
// 1. «Перезапуск» в шапке — РАНЬШЕ на планшете не работал: канала
//    `system:restart` не было в мосте, и кнопку прятали, чтобы не предлагать
//    действие, которое не сработает. Теперь домен `system` подключён к мосту
//    планшета (там перезапуск = перезагрузка WebView), и кнопка вернулась —
//    по тем же правилам, что на компьютере.
//
// 2. Звёздочки разделов (избранное левой панели) — домен `sections` подключён
//    к мосту: запись кладёт раздел в левый блок. Проверку функциональную ведёт
//    смоук-гейт моста на планшете (android-app/src/core/bridge.smoke.test.ts).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const APP = src('./App.tsx');
const SHELL = src('./shellV3/V3TabShell.tsx');

describe('планшетная версия — кнопки, которые там работают', () => {
  it('«Перезапуск» предлагается и на планшете — канал подключён', () => {
    expect(APP, 'перезапуск на планшете работает — прятать кнопку нельзя').toContain(
      '() => void restartApp()',
    );
    expect(APP, 'перезапуск всё ещё выключается платформой').not.toContain(
      'isAndroidPlatform() ? undefined : () => void restartApp()',
    );
  });

  it('кнопка в шапке рисуется только когда обработчик передан', () => {
    expect(SHELL, 'без обработчика кнопка не должна рисоваться').toContain('{props.onRestartApp ? (');
  });
});
