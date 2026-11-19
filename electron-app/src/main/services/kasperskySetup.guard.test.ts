import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Инструкция по настройке Касперского открывается ТОЛЬКО по кнопке.
 *
 * Решение владельца 19.11.2026: окно-инструкция больше не лезет само при старте
 * программы (тем более после обновления — метку «свежая установка» снимали только
 * после нажатия «Готово», и окно возвращалось при каждом запуске). Установщик
 * метку больше не пишет, клиент её не читает, а IPC-двери, которыми она
 * управлялась, сняты. Инструкция остаётся доступной по кнопке в справочном окне
 * «Скрипты обслуживания» — это её единственный вход.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const INSTALLER = read('electron-app/installer/installer.nsh');
/**
 * Только код установщика — без комментариев. Комментарий может СОБОЧНО содержать
 * неверный вызов (так и было: цитата прежней ошибки в комментарии ловилась сторожем),
 * а проверять надо то, что реально компилируется.
 */
const INSTALLER_CODE = INSTALLER.split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith(';'))
  .join('\n');
const SERVICE = read('electron-app/src/main/services/clientOpsService.ts');
const APP = read('electron-app/src/renderer/src/ui/App.tsx');
const CLIENT_OPS_DIALOG = read('electron-app/src/renderer/src/ui/components/ClientOpsDialog.tsx');
const SETUP_DIALOG = read('electron-app/src/renderer/src/ui/components/KasperskySetupDialog.tsx');
const PRELOAD = read('electron-app/src/preload/index.ts');
const IPC = read('electron-app/src/main/ipc/register/clientOps.ts');
const TYPES = read('shared/src/ipc/types.ts');

describe('инструкция по настройке Касперского: только по кнопке, без автопоказа', () => {
  it('установщик метку свежей установки больше не пишет', () => {
    expect(INSTALLER, 'метка осталась в установщике — она ничего не управляет').not.toContain('MarkFreshInstall');
    expect(INSTALLER_CODE, 'метка осталась в коде установщика').not.toContain('kaspersky-setup-needed.flag');
    expect(INSTALLER_CODE, 'у FileOpen ровно три параметра — /o= отсюда лишний').not.toContain('FileOpen /o=');
  });

  it('клиент метку ни не читает, ни не снимает', () => {
    expect(SERVICE).not.toContain('freshInstallFlagPath');
    expect(SERVICE).not.toContain('isFreshInstallPending');
    expect(SERVICE).not.toContain('clearFreshInstallFlag');
    expect(APP, 'программа снова лезет с инструкцией при старте').not.toContain('freshInstallPending');
    expect(APP).not.toContain('freshInstallAck');
  });

  it('окно инструкции само не открывается ни при каких условиях', () => {
    // Автопоказ был единственным местом, где окно открывалось без щелчка.
    expect(APP).not.toMatch(/setKasperskySetupOpen\(true\)\s*;\s*\}\s*,\s*\[authStatus\.loggedIn\]/);
    expect(APP).toMatch(/<KasperskySetupDialog[\s\S]{0,400}open=\{kasperskySetupOpen\}/);
  });

  it('инструкция доступна по кнопке в справочном окне', () => {
    expect(CLIENT_OPS_DIALOG).toContain('onOpenInstruction');
    expect(CLIENT_OPS_DIALOG).toContain('Инструкция для администратора');
    expect(APP).toContain('onOpenInstruction');
  });

  it('окно инструкции показывает текст и запускает помощника', () => {
    expect(SETUP_DIALOG).toContain('clientOps.adminInstruction()');
    expect(SETUP_DIALOG).toContain('Запустить помощник');
  });

  it('проводка IPC на месте с обеих сторон', () => {
    for (const call of ['adminInstruction']) {
      expect(PRELOAD, `в preload нет ${call}`).toContain(call);
      expect(IPC, `в IPC нет ${call}`).toContain(call);
      expect(TYPES, `в типах нет ${call}`).toContain(call);
    }
    // Двери метки сняты — иначе они повиснут в типах мёртвым грузом.
    for (const call of ['freshInstallPending', 'freshInstallAck']) {
      expect(PRELOAD, `в preload осталась мёртвая дверь ${call}`).not.toContain(call);
      expect(IPC, `в IPC осталась мёртвая дверь ${call}`).not.toContain(call);
      expect(TYPES, `в типах осталась мёртвая дверь ${call}`).not.toContain(call);
    }
  });

  it('инструкция для администратора едет в архиве скриптов', () => {
    const builder = read('electron-app/scripts/build-kaspersky-zip.mjs');
    expect(builder).toContain('admin-instruction.ru.md');
    expect(existsSync(path.join(repoRoot, 'scripts', 'client-ops', 'admin-instruction.ru.md'))).toBe(true);
  });
});
