import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Механика «показать инструкцию по Касперскому один раз» держится на трёх тонких местах,
 * и молчаливая поломка каждого из них выглядит одинаково: инструкция просто не появляется.
 *
 *  1. Установщик пишет метку ТОЛЬКО при установке с нуля (`${ifNot} ${isUpdated}`).
 *     При обновлении метки нет — иначе окно лезло бы на каждой настроенной машине.
 *  2. Клиент читает метку из папки данных и снимает её после показа.
 *  3. Кнопка в окне обслуживания открывает ту же инструкцию — на обновлении, где автопоказа
 *     нет, она остаётся единственным способом её найти.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const INSTALLER = read('electron-app/installer/installer.nsh');
const SERVICE = read('electron-app/src/main/services/clientOpsService.ts');
const APP = read('electron-app/src/renderer/src/ui/App.tsx');
const CLIENT_OPS_DIALOG = read('electron-app/src/renderer/src/ui/components/ClientOpsDialog.tsx');
const SETUP_DIALOG = read('electron-app/src/renderer/src/ui/components/KasperskySetupDialog.tsx');
const PRELOAD = read('electron-app/src/preload/index.ts');
const IPC = read('electron-app/src/main/ipc/register/clientOps.ts');
const TYPES = read('shared/src/ipc/types.ts');

describe('инструкция по настройке Касперского: показ на свежей установке и кнопка при обновлении', () => {
  it('установщик пишет метку только при установке с нуля', () => {
    // `${isUpdated}` истинно только когда установку запустил автообновлятель. Метка вне
    // этой ветки означала бы: обновление → окно лезет на машину, которая уже настроена.
    expect(INSTALLER).toContain('!macro MarkFreshInstall');
    expect(INSTALLER).toMatch(/!macro MarkFreshInstall[\s\S]*\$\{ifNot\} \$\{isUpdated\}/);
    expect(INSTALLER).toContain('!insertmacro MarkFreshInstall');
  });

  it('метка лежит в папке данных клиента — она переживает обновления', () => {
    // В папке установки метка исчезала бы при каждом обновлении (каталог заменяется
    // целиком), и «показали один раз» не запоминалось бы.
    expect(SERVICE).toContain("join(app.getPath('userData'), 'kaspersky-setup-needed.flag')");
  });

  it('клиент читает метку и снимает её после показа', () => {
    expect(SERVICE).toContain('export function isFreshInstallPending');
    expect(SERVICE).toContain('export function clearFreshInstallFlag');
    expect(SERVICE).toContain('rmSync(freshInstallFlagPath()');
  });

  it('автопоказ срабатывает после входа в программу', () => {
    // До входа окно закрывало бы экран входа.
    expect(APP).toContain('clientOps.freshInstallPending()');
    expect(APP).toMatch(/if \(!authStatus\.loggedIn\) return;[\s\S]{0,400}freshInstallPending/);
  });

  it('при обновлении инструкция доступна по кнопке в окне обслуживания', () => {
    expect(CLIENT_OPS_DIALOG).toContain('onOpenInstruction');
    expect(CLIENT_OPS_DIALOG).toContain('Инструкция для администратора');
    expect(APP).toContain('onOpenInstruction');
  });

  it('окно инструкции показывает текст и запускает помощника', () => {
    expect(SETUP_DIALOG).toContain('clientOps.adminInstruction()');
    expect(SETUP_DIALOG).toContain('Запустить помощник');
  });

  it('проводка IPC на месте с обеих сторон', () => {
    for (const call of ['adminInstruction', 'freshInstallPending', 'freshInstallAck']) {
      expect(PRELOAD, `в preload нет ${call}`).toContain(call);
      expect(IPC, `в IPC нет ${call}`).toContain(call);
      expect(TYPES, `в типах нет ${call}`).toContain(call);
    }
  });

  it('инструкция для администратора едет в архиве скриптов', () => {
    const builder = read('electron-app/scripts/build-kaspersky-zip.mjs');
    expect(builder).toContain('admin-instruction.ru.md');
    expect(existsSync(path.join(repoRoot, 'scripts', 'client-ops', 'admin-instruction.ru.md'))).toBe(true);
  });
});
