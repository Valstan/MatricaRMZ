import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CLIENT_OPS_SHORTCUT_ID, stripBuiltinDesktopShortcuts, withBuiltinDesktopShortcuts } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

// Скрипты обслуживания лежат на Верстаке у ВСЕХ (решение владельца 07.09.2026), и держится это
// на паре «подмешать при отрисовке / вырезать при записи». Рвётся именно пара: оставить только
// первую половину — и плитка расползётся по 149 профилям, где её уже не вывести из кода;
// оставить вторую — и плитки не будет ни у кого. Обе половины живут в разных строках App.tsx,
// поэтому сторож смотрит на них вместе.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const APP = src('../App.tsx');
const DIALOG = src('./ClientOpsDialog.tsx');
const MENU = src('../shellV2/menuActions.ts');
const ANDROID = src('../shellV2/v2ButtonCatalog.ts');

describe('встроенная плитка «Скрипты обслуживания» доезжает до Верстака', () => {
  it('панель получает секцию с подмешанной плиткой', () => {
    expect(APP, 'Верстак снова рисуется из голого профиля — плитки не будет ни у кого').toContain(
      'desktop={withBuiltinDesktopShortcuts(desktopUi)}',
    );
  });

  it('запись профиля идёт через вырезание встроенных', () => {
    expect(APP, 'встроенная плитка попадёт в профиль и останется там навсегда').toContain(
      'onChange={(next) => setDesktopUi(stripBuiltinDesktopShortcuts(next))}',
    );
  });

  it('нажатие на плитку открывает окно скриптов, а не «пустой ярлык»', () => {
    expect(APP).toContain('if (isBuiltinDesktopLink(link)) {');
    expect(APP).toContain('setClientOpsOpen(true);');
    expect(APP).toContain('<ClientOpsDialog open={clientOpsOpen}');
  });

  it('второй вход — пункт МЕНЮ: у оператора, спрятавшего Верстак, путь остаётся', () => {
    expect(MENU).toContain("{ id: 'client_ops', label: 'Скрипты обслуживания'");
    expect(APP).toContain("case 'client_ops':");
  });

  it('на планшете пункт скрыт: PowerShell там не запустить, архива в сборке нет', () => {
    expect(ANDROID).toContain("'client_ops',");
  });

  it('окно называет пароль архива — без него оператор упрётся в проводник', () => {
    expect(DIALOG).toContain('bundle.password');
  });

  it('пара функций работает и на живых данных — контроль, что сторож не проверяет одни строки', () => {
    const empty = { shortcuts: [], folders: [], layout: { chatPct: 33, peoplePct: 30 } };
    const shown = withBuiltinDesktopShortcuts(empty);
    expect(shown.shortcuts.map((s) => s.id)).toEqual([CLIENT_OPS_SHORTCUT_ID]);
    expect(stripBuiltinDesktopShortcuts(shown).shortcuts).toEqual([]);
  });
});
