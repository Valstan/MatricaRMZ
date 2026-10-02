import { beforeEach, describe, expect, it, vi } from 'vitest';

const scanState = vi.hoisted(() => ({
  supported: true,
  moduleAvailable: true,
  barcodes: [{ displayValue: 'engine:8dc8d68a-3cb2-42e9-9565-f98d13c61e66' }],
  scanError: null as unknown,
  scanCalls: 0,
}));

vi.mock('@capacitor-mlkit/barcode-scanning', () => ({
  BarcodeScanner: {
    isSupported: vi.fn(async () => ({ supported: scanState.supported })),
    isGoogleBarcodeScannerModuleAvailable: vi.fn(async () => ({ available: scanState.moduleAvailable })),
    installGoogleBarcodeScannerModule: vi.fn(async () => {
      scanState.moduleAvailable = true;
    }),
    scan: vi.fn(async () => {
      scanState.scanCalls += 1;
      if (scanState.scanError) throw scanState.scanError;
      return { barcodes: scanState.barcodes };
    }),
  },
}));

import { installEngineQrScanHook } from './qrScan.js';

type Hook = () => Promise<unknown>;

function hook(): Hook {
  installEngineQrScanHook();
  const fn = (globalThis as Record<string, unknown>).__matricarmzQrScan as Hook | undefined;
  if (!fn) throw new Error('hook not installed');
  return fn;
}

beforeEach(() => {
  scanState.supported = true;
  scanState.moduleAvailable = true;
  scanState.barcodes = [{ displayValue: 'engine:8dc8d68a-3cb2-42e9-9565-f98d13c61e66' }];
  scanState.scanError = null;
  scanState.scanCalls = 0;
  delete (globalThis as Record<string, unknown>).__matricarmzQrScan;
});

describe('installEngineQrScanHook', () => {
  it('кладёт хук и отдаёт текст кода', async () => {
    expect(await hook()()).toEqual({ ok: true, text: 'engine:8dc8d68a-3cb2-42e9-9565-f98d13c61e66' });
    expect(scanState.scanCalls).toBe(1);
  });

  it('без камеры — честный отказ без попытки скана', async () => {
    scanState.supported = false;
    expect(await hook()()).toMatchObject({ ok: false });
    expect(scanState.scanCalls).toBe(0);
  });

  it('отмена оператором — cancelled, а не ошибка', async () => {
    scanState.scanError = new Error('Scan canceled by user');
    expect(await hook()()).toEqual({ ok: false, error: 'Сканирование отменено', cancelled: true });
  });

  it('пустой результат — просят навести ближе', async () => {
    scanState.barcodes = [];
    expect(await hook()()).toMatchObject({ ok: false });
  });
});
