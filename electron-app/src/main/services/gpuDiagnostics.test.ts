import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getGPUFeatureStatus: vi.fn(),
    getGPUInfo: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('./logService.js', () => ({ logMessage: vi.fn(async () => undefined) }));

import { app } from 'electron';

import { logMessage } from './logService.js';
import { reportGpuStatus, startGpuDiagnostics, summarizeGpu } from './gpuDiagnostics.js';

const gpuFeatureStatus = vi.mocked(app.getGPUFeatureStatus);
const gpuInfo = vi.mocked(app.getGPUInfo);
const appOn = vi.mocked(app.on);
const logMessageMock = vi.mocked(logMessage);

const HARDWARE_STATUS = {
  gpu_compositing: 'enabled',
  rasterization: 'enabled',
  webgl: 'enabled',
};
const SOFTWARE_STATUS = {
  gpu_compositing: 'disabled_software',
  rasterization: 'disabled_software',
  webgl: 'unavailable_software',
};

describe('сводка аппаратного ускорения', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('аппаратный путь опознаётся, в сводке есть карта и драйвер', () => {
    const verdict = summarizeGpu(HARDWARE_STATUS, {
      gpuDevice: [
        { active: true, deviceString: 'Intel(R) UHD Graphics 730', driverVendor: 'Intel', driverVersion: '31.0.101.5592' },
      ],
    });
    expect(verdict.accelerated).toBe(true);
    expect(verdict.software).toBe(false);
    expect(verdict.device).toBe('Intel(R) UHD Graphics 730');
    expect(verdict.summary).toContain('accelerated=yes');
    expect(verdict.summary).toContain('device="Intel(R) UHD Graphics 730"');
    expect(verdict.summary).toContain('driver="Intel 31.0.101.5592"');
  });

  it('программный рендеринг (SwiftShader) опознаётся по слову software', () => {
    const verdict = summarizeGpu(SOFTWARE_STATUS, null);
    expect(verdict.software).toBe(true);
    expect(verdict.accelerated).toBe(false);
    expect(verdict.summary).toContain('accelerated=no');
    expect(verdict.summary).toContain('compositing=disabled_software');
  });

  it('честно отключённая растеризация не выдаётся за программный рендеринг', () => {
    const verdict = summarizeGpu(
      { gpu_compositing: 'enabled', rasterization: 'disabled_off_ok', webgl: 'enabled' },
      null,
    );
    expect(verdict.software).toBe(false);
    expect(verdict.accelerated).toBe(true);
  });

  it('пустой ответ Chromium не бросает и не выдаётся за аппаратный путь', () => {
    const verdict = summarizeGpu(null, null);
    expect(verdict.accelerated).toBe(false);
    expect(verdict.software).toBe(false);
    expect(verdict.summary).toContain('compositing=unknown');
  });

  it('из нескольких устройств берётся активное', () => {
    const verdict = summarizeGpu(HARDWARE_STATUS, {
      gpuDevice: [
        { active: false, deviceString: 'Microsoft Basic Render Driver' },
        { active: true, deviceString: 'NVIDIA GeForce GTX 1050 Ti' },
      ],
    });
    expect(verdict.device).toBe('NVIDIA GeForce GTX 1050 Ti');
  });
});

describe('доставка статуса в диагностику', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('аппаратный путь — только локальный лог, без warn на сервер', async () => {
    vi.useFakeTimers();
    gpuFeatureStatus.mockReturnValue(HARDWARE_STATUS as never);
    gpuInfo.mockResolvedValue({ gpuDevice: [{ active: true, deviceString: 'Intel(R) UHD Graphics 730' }] });
    const log = vi.fn();

    startGpuDiagnostics({ db: {} as never, apiBaseUrl: 'http://127.0.0.1:9', log });
    await vi.runAllTimersAsync();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('accelerated=yes'));
    expect(logMessageMock).not.toHaveBeenCalled();
  });

  it('программный рендеринг уходит warn’ом с меткой gpu и не повторяется', async () => {
    vi.useFakeTimers();
    gpuFeatureStatus.mockReturnValue(SOFTWARE_STATUS as never);
    gpuInfo.mockResolvedValue(null);
    const log = vi.fn();
    const args = { db: {} as never, apiBaseUrl: 'http://127.0.0.1:9', log };

    startGpuDiagnostics(args);
    await vi.runAllTimersAsync();
    reportGpuStatus(args);
    await vi.runAllTimersAsync();

    const gpuWarns = logMessageMock.mock.calls.filter(
      (call) => typeof call[3] === 'string' && call[3].includes('hardware acceleration unavailable'),
    );
    expect(gpuWarns).toHaveLength(1);
    expect(gpuWarns[0]![2]).toBe('warn');
    expect(gpuWarns[0]![4]).toEqual({ component: 'gpu' });
  });

  it('падение GPU-процесса уходит warn’ом и перепроверяет сводку', async () => {
    vi.useFakeTimers();
    gpuFeatureStatus.mockReturnValue(HARDWARE_STATUS as never);
    gpuInfo.mockResolvedValue({ gpuDevice: [] });
    const onHandlers = new Map<string, (...args: unknown[]) => void>();
    appOn.mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      onHandlers.set(event, handler);
      return app as never;
    }) as never);
    const log = vi.fn();

    startGpuDiagnostics({ db: {} as never, apiBaseUrl: 'http://127.0.0.1:9', log });
    await vi.runAllTimersAsync();
    logMessageMock.mockClear();

    onHandlers.get('child-process-gone')!({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
    await vi.runAllTimersAsync();

    expect(logMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      'http://127.0.0.1:9',
      'warn',
      expect.stringContaining('gpu process gone: reason=crashed'),
      { component: 'gpu' },
    );
  });

  it('штатное завершение GPU-процесса warn’а не шлёт', async () => {
    vi.useFakeTimers();
    gpuFeatureStatus.mockReturnValue(HARDWARE_STATUS as never);
    gpuInfo.mockResolvedValue({ gpuDevice: [] });
    const onHandlers = new Map<string, (...args: unknown[]) => void>();
    appOn.mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      onHandlers.set(event, handler);
      return app as never;
    }) as never);

    startGpuDiagnostics({ db: {} as never, apiBaseUrl: 'http://127.0.0.1:9' });
    await vi.runAllTimersAsync();
    logMessageMock.mockClear();

    onHandlers.get('child-process-gone')!({}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 });
    await vi.runAllTimersAsync();

    expect(logMessageMock).not.toHaveBeenCalled();
  });
});
