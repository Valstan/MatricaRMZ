import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Скан QR бирки двигателя (владелец 02.10.2026): кнопка 📷 рядом с поиском —
// навёл на бирку, номер подставился текстом, дальше штатный поиск/разбор.
// Сторож держит проводку во всех шести местах и мост целиком.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const BUTTON = src('../components/EngineQrScanButton.tsx');
const PRELOAD = src('../../../../preload/index.ts');
const QR_HOOK = src('../../../../../../android-app/src/platform/qrScan.ts');

describe('кнопка скана QR двигателя', () => {
  it('видна только со сканером, ошибки — строкой рядом, отмена молчит', () => {
    expect(BUTTON).toContain('data-qr-scan-engine');
    expect(BUTTON).toContain('if (!supported) return null;');
    expect(BUTTON).toContain('parseEngineQrValue(r.text)');
    expect(BUTTON).toContain("if (!r.cancelled) setError(");
    expect(BUTTON).toContain("setError('Это не бирка двигателя');");
    expect(BUTTON).toContain('attributes?.engine_number');
  });

  it('мост scan описан в контракте и реализован в preload через хук планшета', () => {
    expect(PRELOAD).toContain('__matricarmzQrScan');
    expect(PRELOAD).toContain('qrSupported');
    expect(PRELOAD).toContain('qrScan');
  });

  it('хук планшета ставит сканер до renderer и разбирает отмену', () => {
    expect(QR_HOOK).toContain('__matricarmzQrScan');
    expect(QR_HOOK).toContain('BarcodeScanner.scan()');
    expect(QR_HOOK).toContain('isGoogleBarcodeScannerModuleAvailable');
    expect(QR_HOOK).toContain('cancelled: true');
  });

  it('поиски двигателей зовут кнопку с подстановкой номера в запрос', () => {
    const engines = src('./EnginesPage.tsx');
    expect(engines).toContain('<EngineQrScanButton onEngineNumber={(n) => patchState({ query: n, page: 0 })} />');
    const sheets = src('./WorkSheetsPage.tsx');
    expect(sheets).toContain('<EngineQrScanButton onEngineNumber={(n) => patchState({ query: n })} />');
    const global = src('../components/GlobalSearchOverlay.tsx');
    expect(global).toContain('<EngineQrScanButton');
    expect(global).toContain('setQuery(n);');
    const bulk = src('../components/BulkStageAddDialog.tsx');
    expect(bulk).toContain('<EngineQrScanButton onEngineNumber={(n) => setQuery(n)} />');
    const tags = src('../components/EngineTagPrintDialog.tsx');
    expect(tags).toContain('<EngineQrScanButton onEngineNumber={(n) => setQuery(n)} />');
  });

  it('пикеры двигателя сканируют через то же поле с штатным разбором', () => {
    const field = src('../components/EntityReferenceField.tsx');
    expect(field).toContain("props.target === 'engine'");
    expect(field).toContain('<EngineQrScanButton');
    expect(field).toContain('void resolveOnBlur(number);');
  });
});
