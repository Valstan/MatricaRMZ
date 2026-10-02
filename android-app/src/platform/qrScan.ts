import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';

export type EngineQrScanResult = { ok: true; text: string } | { ok: false; error: string; cancelled?: boolean };

function messageOf(e: unknown): string {
  const raw = String(e instanceof Error ? e.message : (e ?? '')).trim();
  return raw || 'Не удалось отсканировать';
}

/**
 * Нативный скан QR бирки двигателя (системный UI сканера Google).
 * Ставится глобальным хуком до загрузки renderer — мост preload его подхватывает.
 * Отмены оператором — тихий `cancelled`, а не ошибка: крестик в сканере — штатный выход.
 */
export function installEngineQrScanHook(): void {
  (globalThis as Record<string, unknown>).__matricarmzQrScan = async (): Promise<EngineQrScanResult> => {
    try {
      const supported = await BarcodeScanner.isSupported().catch(() => ({ supported: false }));
      if (supported.supported !== true) {
        return { ok: false, error: 'На этом планшете нет камеры для сканирования' };
      }
      const module = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable().catch(() => ({ available: false }));
      if (module.available !== true) {
        try {
          await BarcodeScanner.installGoogleBarcodeScannerModule();
        } catch {
          return { ok: false, error: 'Нет модуля сканера Google — нужны интернет и сервисы Google' };
        }
        const retry = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable().catch(() => ({ available: false }));
        if (retry.available !== true) {
          return { ok: false, error: 'Нет модуля сканера Google — нужны интернет и сервисы Google' };
        }
      }
      const { barcodes } = await BarcodeScanner.scan();
      const text = String(barcodes?.[0]?.rawValue ?? barcodes?.[0]?.displayValue ?? '').trim();
      if (!text) return { ok: false, error: 'Код не распознан — наведите на бирку ближе' };
      return { ok: true, text };
    } catch (e) {
      const msg = messageOf(e);
      if (/cancel/i.test(msg)) return { ok: false, error: 'Сканирование отменено', cancelled: true };
      return { ok: false, error: msg };
    }
  };
}
