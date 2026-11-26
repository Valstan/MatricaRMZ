// Печать картинок через СИСТЕМНЫЙ мастер печати фотографий (промт КАРМАНА #102).
//
// Что это: владелец попросил печать «через Microsoft Picture Manager, чтобы можно
// было скорректировать размер картинок и отправить уже на печать». Отдельной
// программы «Microsoft Picture Manager» в современной Windows нет (`imprint.exe`
// отсутствует), но есть **живой эквивалент** — системный глагол печати картинки:
//
//   HKCR\SystemFileAssociations\image\shell\print
//     → DropTarget {60fd46de-f830-4894-a628-6fa81bc0190d} = photowiz.dll
//       («мастер печати фотографий»: выбираешь размер и раскладку, потом печать)
//
// Из Electron вызвать глагол нельзя: в `shell` есть только openPath /
// openExternal / showItemInFolder / trashItem — вызова с `verb` нет. Рабочий
// путь — `Start-Process -FilePath '<файл>' -Verb print` из PowerShell (прецедент
// вызова PowerShell из main — `clientOpsService.ts`).
//
// Windows-only: на других системах глагола нет — отвечаем честно, а не молча.

import { spawn } from 'node:child_process';

/** Максимум картинок за один вызов: каждый открывает своё системное окно. */
export const MAX_OS_PRINT_FILES = 50;

/**
 * Сколько живёт процесс, открывший мастер печати.
 *
 * ⚠️ Окно мастера печати живёт, пока живёт процесс, который его открыл: если
 * тот сразу выходит, окно закрывается вместе с ним (проверено на PC79
 * 26.11.2026 — `Start-Process -Verb print` из одноразовой команды: окно
 * «Печать изображений» появилось и пропало, едва команда завершилась).
 * Поэтому процесс-открыватель должен пережить мастер.
 */
const WIZARD_KEEP_ALIVE_SECONDS = 600;

/** Экранирование пути для строки PowerShell в одинарных кавычках. */
function psSingleQuoted(path: string): string {
  return `'${String(path ?? '').replace(/'/g, "''")}'`;
}

/**
 * Открыть системный мастер печати фотографий для одной картинки.
 *
 * Возвращает `false`, если глагол не сработал (нет обработчика картинок, Photos
 * сломан, печать недоступна) — вызывающий покажет оператору внятное сообщение и
 * предложит запасной путь «Печать» (диалог Chromium), а не тишину.
 */
export function printImageViaOsWizard(path: string): Promise<boolean> {
  const clean = String(path ?? '').trim();
  if (!clean) return Promise.resolve(false);
  if (process.platform !== 'win32') return Promise.resolve(false);

  // `-ErrorAction Stop` + `exit 1`: иначе Start-Process на отсутствующий глагол
  // отдаёт некритичную ошибку и скрипт вышел бы с кодом 0 — мы бы решили, что
  // печать открылась, а оператор не увидел бы ничего.
  //
  // `Write-Output 'started'` — сигнал «глагол сработал»: по нему вызывающий
  // сразу отвечает оператору, не дожидаясь закрытия мастера.
  const script =
    `$ErrorActionPreference = 'Stop'\n` +
    `try { Start-Process -FilePath ${psSingleQuoted(clean)} -Verb print -ErrorAction Stop } ` +
    `catch { exit 1 }\n` +
    `Write-Output 'started'\n` +
    `Start-Sleep -Seconds ${WIZARD_KEEP_ALIVE_SECONDS}`;

  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script],
        // НЕ detached и НЕ windowsHide: по грабле из `clientOpsService.ts` оба
        // флага убивают графическое окно. Консоль PowerShell прячет сам
        // `-WindowStyle Hidden`.
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: false },
      );
      let settled = false;
      let out = '';
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      child.stdout?.on('data', (chunk) => {
        out += String(chunk);
        // Мастер открыт — отвечаем сразу; процесс продолжает жить и держать окно.
        if (out.includes('started')) finish(true);
      });
      child.on('error', () => finish(false));
      child.on('exit', (code) => finish(out.includes('started') ? true : code === 0));
      // Страховка: если процесс «завис» — не держим оператора в ожидании.
      setTimeout(() => finish(out.includes('started')), 15000).unref?.();
    } catch {
      resolve(false);
    }
  });
}

/**
 * Печать нескольких картинок через системный мастер.
 *
 * Один файл — одно системное окно (`Start-Process` берёт один путь). Окна
 * открываются по очереди с паузой, чтобы не накрыть друг друга.
 */
export async function printImagesViaOsWizard(
  paths: string[],
): Promise<{ ok: true; opened: number; failed: number } | { ok: false; error: string }> {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Системный мастер печати фотографий — только на Windows' };
  }
  const list = paths.map((p) => String(p ?? '').trim()).filter(Boolean);
  if (list.length === 0) return { ok: false, error: 'Не выбрано ни одной картинки' };
  const take = list.slice(0, MAX_OS_PRINT_FILES);
  let opened = 0;
  let failed = 0;
  for (const path of take) {
    const ok = await printImageViaOsWizard(path);
    if (ok) opened += 1;
    else failed += 1;
    // Пауза между окнами: они иначе накрывают друг друга.
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  if (opened === 0) {
    return {
      ok: false,
      error:
        failed > 0
          ? 'Системный мастер печати не открылся — для этого типа файла нет обработчика. Нажмите «Печать» — печать через диалог.'
          : 'Системный мастер печати не открылся. Нажмите «Печать» — печать через диалог.',
    };
  }
  return { ok: true, opened, failed };
}

/** Доступен ли системный мастер печати на этой машине. */
export function osPrintWizardAvailable(): boolean {
  return process.platform === 'win32';
}
