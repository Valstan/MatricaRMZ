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

  it('нажатие на плитку сразу запускает окно скриптов, а не «пустой ярлык»', () => {
    // Решение владельца 19.11.2026: щелчок по плитке на Верстаке распаковывает архив и
    // поднимает главный скрипт с окном — без лишнего окна внутри программы.
    expect(APP).toContain('if (isBuiltinDesktopLink(link)) {');
    expect(APP).toContain('void launchClientOpsWindow();');
    expect(APP).toContain('window.matrica.clientOps');
    expect(APP).toContain('.launch(tab ? { tab } : {})');
  });

  it('если окно не поднялось — открывается запасной путь (справочное окно)', () => {
    // Отказ запуска не должен оставлять оператора ни с чем: справочное окно даёт архив
    // в проводнике, копию в «Загрузки» и пароль.
    expect(APP).toMatch(/launchClientOpsWindow[\s\S]{0,900}setClientOpsOpen\(true\)/);
    expect(APP).toMatch(/<ClientOpsDialog[\s\S]{0,200}open=\{clientOpsOpen\}/);
  });

  it('второй вход — пункт МЕНЮ: у оператора, спрятавшего Верстак, путь остаётся', () => {
    expect(MENU).toContain("{ id: 'client_ops', label: 'Скрипты обслуживания'");
    expect(APP).toContain("case 'client_ops':");
  });

  it('на планшете пункт скрыт: PowerShell там не запустить, архива в сборке нет', () => {
    expect(ANDROID).toContain("'client_ops',");
  });

  it('кнопка открывает окно обслуживания, а не отправляет оператора в проводник', () => {
    // Основной путь — запуск. Раньше им был «вот архив, вот пароль»; каждый ручной шаг там
    // терял часть парка, и вернуть его обратно молча нельзя.
    expect(DIALOG).toContain('window.matrica.clientOps.launch');
  });

  it('запасной путь остался и по-прежнему называет пароль архива', () => {
    // Окно открывается не везде (нет PowerShell, политика запуска). Тогда у оператора должен
    // остаться файл и пароль к нему — иначе отказ запуска означает тупик.
    expect(DIALOG).toContain('bundle.password');
    expect(DIALOG).toContain("run('reveal')");
    expect(DIALOG).toContain("run('saveCopy')");
  });

  it('окно скрипта запускается так, чтобы оно БЫЛО видно (грабля M214)', () => {
    // `detached: true` и `windowsHide: true` у Node убивают графическое окно PowerShell:
    // процесс стартует и молча уходит, оператор видит только уведомление. Консоль прячет
    // сам PowerShell флагом `-WindowStyle Hidden`.
    const service = src('../../../../main/services/clientOpsService.ts');
    expect(service).toContain("'-WindowStyle', 'Hidden'");
    expect(service, 'detached убивает окно — грабля M214').not.toMatch(/spawn\([\s\S]{0,600}detached:\s*true/);
    expect(service, 'windowsHide убивает окно — грабля M214').not.toMatch(/spawn\([\s\S]{0,600}windowsHide:\s*true/);
  });

  it('пара функций работает и на живых данных — контроль, что сторож не проверяет одни строки', () => {
    const empty = { shortcuts: [], folders: [], layout: { chatPct: 33, peoplePct: 30 } };
    const shown = withBuiltinDesktopShortcuts(empty);
    expect(shown.shortcuts.map((s) => s.id)).toEqual([CLIENT_OPS_SHORTCUT_ID]);
    expect(stripBuiltinDesktopShortcuts(shown).shortcuts).toEqual([]);
  });
});
