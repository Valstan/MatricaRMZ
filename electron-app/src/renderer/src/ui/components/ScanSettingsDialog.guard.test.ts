import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож настроек скана (промт КАРМАНА #178).
//
// Что он держит:
//   * окно даёт выбрать РЕЖИМ, РАЗРЕШЕНИЕ и РАЗМЕР — без них скан уходит в
//     чёрно-белом и в низком разрешении (так и было);
//   * съём идёт С ПАРАМЕТРАМИ: разрешение и тип данных ставятся ДО Transfer();
//   * у окна есть полоса прогресса по этапам;
//   * имя файла правится прямо в окне, ластик его очищает;
//   * внизу окна — «Сохранить скан в программе», а не «Окей»;
//   * две фазы: до «Сохранить скан в программе» в папке объекта файлов нет.
//
// Сторож смотрит в КОД, а не в скриншот: правило «окно настроек есть» нельзя
// проверить глазами на каждой правке, а вот «окно опять без настроек» — можно.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const DIALOG = src('./ScanSettingsDialog.tsx');
const PANEL = src('./AttachmentsPanel.tsx');
const SERVICE = src('../../../../main/services/scannerService.ts');
const SCANNER_IPC = src('../../../../main/ipc/register/scanner.ts');
const PRELOAD = src('../../../../preload/index.ts');
const DOMAIN = src('../../../../../../shared/src/domain/scanDocument.ts');

/**
 * Только скрипт СЪЁМА — без скрипта разведки.
 *
 * Разведка (caps) по праву перебирает разрешения: это ПРОБА, а не съёмка. Если
 * проверять по всему файлу, сторож увидит пробу и решит, что параметры задаются.
 */
const CAPTURE_SCRIPT = SERVICE.slice(
  SERVICE.indexOf('const WIA_CAPTURE_SCRIPT'),
  SERVICE.indexOf('/** Собрать команду PowerShell'),
);

describe('окно скана даёт выбрать настройки (промт КАРМАНА #178)', () => {
  it('в домене есть все три режима, оба разрешения и три размера', () => {
    // Критерий приёмки: «выбор разрешения: 150 и 300 dpi», «выбор режима: цветное,
    // чёрно-белое, серое», «выбор размера: A4, A3 и максимум».
    expect(DOMAIN).toContain("SCAN_RESOLUTION_CHOICES: readonly ScanResolutionChoice[] = [150, 300, 'max']");
    expect(DOMAIN).toContain("SCAN_MODE_CHOICES: readonly ScanMode[] = ['color', 'grayscale', 'blackwhite']");
    expect(DOMAIN).toContain("SCAN_SIZE_CHOICES: readonly ScanSize[] = ['a4', 'a3', 'max']");
  });

  it('окно рисует все эти варианты, а не один-два', () => {
    expect(DIALOG).toContain('SCAN_RESOLUTION_CHOICES');
    expect(DIALOG).toContain('SCAN_MODE_CHOICES');
    expect(DIALOG).toContain('SCAN_SIZE_CHOICES');
    expect(DIALOG).toContain('SCAN_MODE_LABELS[mode]');
    expect(DIALOG).toContain('SCAN_SIZE_LABELS[size]');
  });

  it('по умолчанию — цвет и максимум сканера', () => {
    expect(DOMAIN).toContain("SCAN_DEFAULT_SETTINGS: ScanSettings = {");
    expect(DOMAIN).toContain("mode: 'color'");
    expect(DOMAIN).toContain("resolution: 'max'");
  });
});

describe('съём идёт с заданными параметрами', () => {
  it('разрешение и тип данных ставятся ДО Transfer()', () => {
    // Главная проверка сторожа: если параметры будут ставиться после съёма или
    // не будут вовсе — скан снова уйдёт в чёрно-белом и низком разрешении.
    const setRes = CAPTURE_SCRIPT.indexOf('TrySet $xres $t');
    const setType = CAPTURE_SCRIPT.indexOf('TrySet $dt $t');
    const transfer = CAPTURE_SCRIPT.indexOf('$item.Transfer()');
    expect(setRes, 'разрешение не задаётся при съёме').toBeGreaterThan(0);
    expect(setType, 'тип данных (режим) не задаётся при съёме').toBeGreaterThan(0);
    expect(transfer, 'съём не найден').toBeGreaterThan(0);
    expect(setRes, 'разрешение ставится ПОСЛЕ съёма').toBeLessThan(transfer);
    expect(setType, 'режим ставится ПОСЛЕ съёма').toBeLessThan(transfer);
  });

  it('размер области задаётся тоже — кадр не обрезается по листу', () => {
    expect(CAPTURE_SCRIPT).toContain('TrySet $xe $targetW');
    expect(CAPTURE_SCRIPT).toContain('TrySet $ye $targetH');
  });

  it('сканер сначала спрашивается, что он умеет, — иначе 300 dpi молча уедут в 200', () => {
    expect(SERVICE).toContain('probeScanCapabilities');
    expect(SERVICE).toContain('resolveScanResolution');
    // Фактическое разрешение оператору показывается — не обещание, а правда.
    expect(SERVICE).toContain('actual: ScanActual');
  });
});

describe('у окна есть полоса прогресса', () => {
  it('окно подписывается на прогресс и рисует полосу', () => {
    expect(DIALOG).toContain('window.matrica.scan.onProgress');
    expect(DIALOG).toContain('data-scan-progress');
    expect(DIALOG).toContain('progressPercent');
  });

  it('этапы съёма объявлены в домене — «ищем сканер → снимаем → сохраняем»', () => {
    expect(DOMAIN).toContain("SCAN_PROGRESS_STAGES: readonly ScanProgressStage[] = ['searching', 'capturing', 'saving']");
  });

  it('главный процесс шлёт прогресс в окна', () => {
    expect(SCANNER_IPC).toContain("webContents.send('scan:progress'");
    expect(PRELOAD).toContain("ipcRenderer.on('scan:progress'");
  });
});

describe('имя файла правится прямо в окне', () => {
  it('в окне есть поле имени и кнопка-ластик «Стереть резинку»', () => {
    expect(DIALOG).toContain('Стереть резинку');
    expect(DIALOG).toContain('EraserButton');
    expect(DIALOG).toContain('setFileName(\'\')');
  });

  it('имя, предложенное программой, сохраняется, если оператор его не трогал', () => {
    expect(DIALOG).toContain('nameTouched.current');
    expect(DIALOG).toContain('buildScanFileName');
  });

  it('внизу окна — «Сохранить скан в программе», а отдельной «Окей» нет', () => {
    expect(DIALOG).toContain('Сохранить скан в программе');
    expect(DIALOG).not.toContain('Окей');
  });
});

describe('две фазы: съём — потом имя', () => {
  it('кадр кладётся в объект только по кнопке «Сохранить скан в программе»', () => {
    // До нажатия в папке объекта файлов нет: кадр лежит во временной папке.
    expect(DIALOG).toContain('window.matrica.scan.place');
    expect(DIALOG).toContain('const saveScan = useCallback');
    // Отмена убирает несъёмный кадр, чтобы в папке объекта не осталось мусора.
    expect(DIALOG).toContain('window.matrica.scan.discard');
  });

  it('скан идёт в объект тем же путём, что и файл с диска', () => {
    expect(PANEL).toContain('await uploadTasks([{ path: file.path, fileName: file.fileName }])');
  });
});

describe('одно окно — во всех местах, где есть «Со сканера»', () => {
  it('панель вложений открывает именно это окно', () => {
    expect(PANEL).toContain('<ScanSettingsDialog');
    // Съём идёт из окна, а не из панели: настройки и имя — в одном месте.
    expect(PANEL).not.toContain('window.matrica.scan.document');
  });

  it('панель вложений — та же самая, что в карточке двигателя, договоре, контрагенте и модуле вложений', () => {
    // Все эти карточки ставят `AttachmentsPanel`, а кнопка «Со сканера» — одна.
    expect(PANEL).toContain('🖨 Со сканера');
  });

  it('каналы проходят через preload', () => {
    expect(SCANNER_IPC).toContain("ipcMain.handle('scan:capabilities'");
    expect(SCANNER_IPC).toContain("ipcMain.handle('scan:document'");
    expect(SCANNER_IPC).toContain("ipcMain.handle('scan:place'");
    expect(PRELOAD).toContain("ipcRenderer.invoke('scan:capabilities'");
    expect(PRELOAD).toContain("ipcRenderer.invoke('scan:document'");
  });

  it('скан не обходит право на загрузку', () => {
    expect(SCANNER_IPC).toContain("requirePermOrResult(ctx, 'files.upload')");
  });
});
