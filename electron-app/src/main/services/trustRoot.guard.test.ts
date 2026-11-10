import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Цепочка доверия рвётся молча и целиком.
 *
 * Клиент проверяет корень и ставит его сам, но для этого ему нужны три файла, которые едут
 * в инсталляторе отдельным шагом сборки: публичная часть корня, скрипт установки и скрипт
 * опроса. Забыли добавить любой из них — сборка останется зелёной (шаг beforePack не
 * смотрит на список extraResources), а на машине парка программа скажет «не могу проверить»
 * вместо «всё сделал». Ни один тест кода этого не заметит: дело в одной строке списка.
 *
 * Сторож сверяет концы цепочки между собой: что едет в поставку, что клиент запускает и что
 * лежит в исходниках. Плюс — две вещи, которые ломаются не списком, а поведением:
 *  - опрос обязан быть ТОЛЬКО НА ЧТЕНИЕ (иначе «проверка состояния» меняет машину);
 *  - скрипты обязаны быть с BOM (иначе PowerShell 5.1 читает кириллицу как ANSI и скрипт
 *    не запускается — ровно это мы уже наловили при написании пробы).
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const PROBE = read('scripts/signing/trust-root-probe.ps1');
const INSTALL = read('scripts/signing/install-root-on-machine.ps1');
const SERVICE = read('electron-app/src/main/services/trustRootService.ts');
const BUILDER = read('electron-app/scripts/build-trust-assets.mjs');
const PANEL = read('electron-app/src/renderer/src/ui/components/TrustRootPanel.tsx');
const NOTICE = read('electron-app/src/renderer/src/ui/components/TrustRootNoticeDialog.tsx');
const APP = read('electron-app/src/renderer/src/ui/App.tsx');
const PACKAGE = read('electron-app/package.json');

/** Файлы, которые клиент ищет на диске. */
const PROBE_SCRIPT = 'trust-root-probe.ps1';
const INSTALL_SCRIPT = 'install-root-on-machine.ps1';
const ROOT_CERT = 'matrixarmz-rootca.cer';

describe('поставка файлов доверия собрана целиком', () => {
  it('сборщик кладёт в клиент те же файлы, что клиент ищет', () => {
    // Клиент запускает два скрипта по имени. Корневой .cer клиент не ищет: его находит
    // сам скрипт установки (Join-Path $PSScriptRoot) — поэтому .cer должен лежать РЯДОМ
    // со скриптом, иначе установка не найдёт сертификат.
    for (const name of [PROBE_SCRIPT, INSTALL_SCRIPT]) {
      expect(BUILDER, `${name} не попадает в сборку клиента`).toContain(name);
      expect(SERVICE, `клиент не ищет ${name}`).toContain(name);
    }
    expect(BUILDER, `публичная часть корня (${ROOT_CERT}) не едет с клиентом`).toContain(ROOT_CERT);
    expect(INSTALL, 'скрипт установки ищет корень рядом с собой').toContain('matrixarmz-rootca.cer');
  });

  it('каждый файл, который едет в клиент, объявлен в extraResources', () => {
    for (const name of [ROOT_CERT, INSTALL_SCRIPT, PROBE_SCRIPT]) {
      expect(PACKAGE, `${name} не объявлен в extraResources — в инсталляторе его не будет`).toContain(
        `"build/trust/${name}"`,
      );
    }
  });

  it('исходники лежат на своих местах в репозитории', () => {
    for (const name of [PROBE_SCRIPT, INSTALL_SCRIPT, ROOT_CERT]) {
      expect(BUILDER, `сборщик берёт ${name} не из scripts/signing`).toContain(
        `scripts/signing/${name}`,
      );
    }
  });

  it('скрипты лежат в UTF-8 с BOM — без него PowerShell 5.1 читает их как ANSI', () => {
    for (const rel of ['scripts/signing/trust-root-probe.ps1', 'scripts/signing/install-root-on-machine.ps1']) {
      const head = readFileSync(path.join(repoRoot, rel)).subarray(0, 3);
      expect([...head], `${rel} без BOM`).toEqual([0xef, 0xbb, 0xbf]);
    }
  });
});

describe('опрос состояния — только чтение', () => {
  it('проба ничего не меняет в хранилищах сертификатов', () => {
    // Если «проверка» начнёт что-то ставить, её нельзя будет звать при каждом запуске.
    expect(PROBE).not.toMatch(/\.Add\(/);
    expect(PROBE).not.toMatch(/Remove-Item/);
    expect(PROBE).not.toMatch(/New-SelfSignedCertificate/);
    expect(PROBE).not.toMatch(/Set-AuthenticodeSignature/);
  });

  it('проба открывает хранилища только на чтение', () => {
    expect(PROBE).toContain('OpenFlags]::ReadOnly');
  });

  it('проба спрашивает и машинные, и пользовательские хранилища', () => {
    // Касперский читает машинные, Windows — пользовательские: без обоих картина неполная.
    expect(PROBE).toContain("Location = 'LocalMachine'");
    expect(PROBE).toContain("Location = 'CurrentUser'");
  });
});

describe('установка корня идёт тем же скриптом, что и у администратора', () => {
  it('клиент не заводит своего установщика — он зовёт общий скрипт', () => {
    // Свой детектор и свой установщик в проекте не заводим: одна правда и один рецепт.
    expect(SERVICE).toContain("const INSTALL_SCRIPT = 'install-root-on-machine.ps1'");
    expect(SERVICE).not.toMatch(/X509Store/);
  });

  it('пользовательское хранилище ставится без прав администратора', () => {
    expect(SERVICE).toContain("['-Scope', 'CurrentUser', '-Quiet']");
  });

  it('машинное хранилище — через тот же скрипт (он сам поднимает права)', () => {
    expect(SERVICE).toContain("['-Scope', 'Machine']");
    // Скрипт обязан уметь поднять права сам: программа не может их выдать.
    expect(INSTALL).toContain('-Verb RunAs');
  });

  it('отпечаток корня в пробе и в домене — один и тот же', () => {
    const dom = read('shared/src/domain/trustRoot.ts');
    const thumb = dom.match(/MATRICA_ROOT_CA_THUMBPRINT = '([0-9A-F]+)'/)?.[1];
    expect(thumb, 'в домене нет отпечатка корня').toBeTruthy();
    expect(PROBE, 'проба ищет другой корень').toContain(thumb!);
    expect(INSTALL, 'скрипт установки работает с другим корнем').not.toContain('0000000000');
  });
});

describe('подсказка доходит до человека', () => {
  it('панель показывает инструкцию администратору', () => {
    expect(PANEL).toContain('adminInstructions');
    expect(PANEL).toContain('Что делать системному администратору');
  });

  it('окно-подсказка зовёт ту же панель — текст один на оба места', () => {
    expect(NOTICE).toContain('<TrustRootPanel');
    expect(NOTICE).toContain('useTrustRoot');
  });

  it('программа показывает подсказку при запуске и отмечает, что показала', () => {
    expect(APP).toContain('<TrustRootNoticeDialog');
    expect(APP).toContain('window.matrica.trustRoot.notice()');
    expect(APP).toContain('window.matrica.trustRoot.noticeAck()');
  });

  it('инструкция говорит про Касперского прямо: эту настройку программно не включить', () => {
    const dom = read('shared/src/domain/trustRoot.ts');
    expect(dom).toContain('Самозащита');
    expect(dom).toContain('Доверенное системное хранилище сертификатов');
    // И главное — не обещать того, чего нет: корень в профиле НЕ даёт доверия Касперскому.
    expect(dom).toContain('машинн');
  });
});
