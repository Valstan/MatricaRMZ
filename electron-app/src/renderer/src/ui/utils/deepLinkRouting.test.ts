import { describe, expect, it } from 'vitest';

import { resolveDeepLinkRoute } from './deepLinkRouting.js';

describe('resolveDeepLinkRoute', () => {
  it('resolves a generic favorite card link', () => {
    expect(resolveDeepLinkRoute({
      kind: 'app_link',
      tab: 'engine_assembly_bom_item' as any,
      cardKind: 'engine_assembly_bom_item',
      entityId: 'bom-1',
    })).toEqual({ kind: 'card', cardKind: 'engine_assembly_bom_item', id: 'bom-1' });
  });
  it('routes report preset link to report_preset entity', () => {
    const route = resolveDeepLinkRoute({
      kind: 'app_link',
      tab: 'report_preset' as any,
      reportPresetId: 'assembly_forecast_7d',
    } as any);

    expect(route).toEqual({ kind: 'report_preset', id: 'assembly_forecast_7d' });
  });

  it('prioritizes entity ID over tab', () => {
    const route = resolveDeepLinkRoute({
      kind: 'app_link',
      tab: 'reports' as any,
      reportPresetId: 'assembly_forecast_7d',
    } as any);

    expect(route).toEqual({ kind: 'report_preset', id: 'assembly_forecast_7d' });
  });

  it('routes a legacy part link to the nomenclature card', () => {
    const route = resolveDeepLinkRoute({
      kind: 'app_link',
      tab: 'part' as any,
      partId: 'p-1',
    } as any);

    expect(route).toEqual({ kind: 'nomenclature', id: 'p-1' });
  });

  it('falls back to tab when entity IDs are missing', () => {
    const route = resolveDeepLinkRoute({
      kind: 'app_link',
      tab: 'reports' as any,
    } as any);

    expect(route).toEqual({ kind: 'tab', id: 'reports' });
  });
});
