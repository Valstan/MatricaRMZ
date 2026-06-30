import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * Регресс на урок hotfix v1.29.1: route-handler `/warehouse/forecast/assembly-7d`
 * маппит каждую forecast-строку через inline-литерал. В v1.29.0 этот map сузил row
 * до 8 полей и **тихо отбросил** `requiredParts` + `variantKey` (TypeScript не
 * предупредил — inline-тип «казался полным»), из-за чего Stage 4-кнопка «Создать
 * наряд на сборку» не рендерилась. Тест фиксирует, что для row со status='ok' оба
 * поля доходят до JSON-ответа, плюс top-level `existingAssemblyOrdersByVariantKey`.
 */

const mocks = vi.hoisted(() => ({
  computeAssemblyForecastFromServer: vi.fn(),
}));

vi.mock('../auth/middleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'u-admin', username: 'admin', role: 'admin' };
    next();
  },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../services/warehouseForecastService.js', () => ({
  computeAssemblyForecastFromServer: mocks.computeAssemblyForecastFromServer,
}));

import { createApp } from '../app.js';

describe('POST /warehouse/forecast/assembly-7d response mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards requiredParts + variantKey for status=ok rows and top-level existingAssemblyOrdersByVariantKey', async () => {
    mocks.computeAssemblyForecastFromServer.mockResolvedValue({
      rows: [
        {
          dayLabel: 'Пн 02.06',
          engineBrand: 'ЯМЗ-238',
          brandId: '11111111-1111-1111-1111-111111111111',
          plannedEngines: 3,
          status: 'ok',
          requiredComponentsSummary: 'Поршень ×3',
          deficitsSummary: '',
          alternativeBrands: [],
          requiredParts: [{ nomenclatureId: 'n-1', name: 'Поршень', qty: 3 }],
          variantKey: 'assembly:11111111-1111-1111-1111-111111111111:0',
        },
      ],
      warnings: ['тестовое предупреждение'],
      deficitRecommendations: [],
      horizonMissingByBrand: {},
      horizonComponentNeeds: [],
      existingAssemblyOrdersByVariantKey: {
        'assembly:11111111-1111-1111-1111-111111111111:0': { workOrderId: 'wo-9', workOrderNo: 'НС-9' },
      },
    });

    const app = createApp();
    const res = await request(app)
      .post('/warehouse/forecast/assembly-7d')
      .send({ targetEnginesPerDay: 3 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = res.body.rows[0];
    expect(row.status).toBe('ok');
    // Поля из Stage 4, которые v1.29.0 терял:
    expect(row.requiredParts).toEqual([{ nomenclatureId: 'n-1', name: 'Поршень', qty: 3 }]);
    expect(row.variantKey).toBe('assembly:11111111-1111-1111-1111-111111111111:0');
    // Базовые поля по-прежнему на месте:
    expect(row.engineBrand).toBe('ЯМЗ-238');
    expect(row.plannedEngines).toBe(3);

    expect(res.body.existingAssemblyOrdersByVariantKey).toEqual({
      'assembly:11111111-1111-1111-1111-111111111111:0': { workOrderId: 'wo-9', workOrderNo: 'НС-9' },
    });
    expect(res.body.warnings).toEqual(['тестовое предупреждение']);
  });

  it('omits requiredParts/variantKey when the forecast row has none (no undefined leak)', async () => {
    mocks.computeAssemblyForecastFromServer.mockResolvedValue({
      rows: [
        {
          dayLabel: 'Вт 03.06',
          engineBrand: 'ЯМЗ-240',
          brandId: '22222222-2222-2222-2222-222222222222',
          plannedEngines: 0,
          status: 'weekend',
          requiredComponentsSummary: '',
          deficitsSummary: '',
          alternativeBrands: [],
        },
      ],
      warnings: [],
      deficitRecommendations: [],
      horizonMissingByBrand: {},
      horizonComponentNeeds: [],
    });

    const app = createApp();
    const res = await request(app)
      .post('/warehouse/forecast/assembly-7d')
      .send({ targetEnginesPerDay: 0 });

    expect(res.status).toBe(200);
    const row = res.body.rows[0];
    expect(row.status).toBe('weekend');
    expect(row).not.toHaveProperty('requiredParts');
    expect(row).not.toHaveProperty('variantKey');
    expect(res.body).not.toHaveProperty('existingAssemblyOrdersByVariantKey');
  });

  it('rejects invalid body with 400', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/warehouse/forecast/assembly-7d')
      .send({ targetEnginesPerDay: -1 });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(mocks.computeAssemblyForecastFromServer).not.toHaveBeenCalled();
  });
});
