import { describe, expect, it } from 'vitest';

import { DEFAULT_REPAIR_STAGE_TEMPLATES } from './repairStages.js';

// Canonical list of stage templates. This is the fallback for every client
// (Electron, Android, web-admin) when the server set is unavailable, so it must
// always carry the full set — otherwise an offline client has a different set
// and fails with "no such stage".
describe('DEFAULT_REPAIR_STAGE_TEMPLATES — один единый список', () => {
  const CODES = DEFAULT_REPAIR_STAGE_TEMPLATES.map((t) => t.code);

  it('содержит этапы линейки (в т.ч. Укладка вала)', () => {
    for (const code of [
      'card_created',
      'arrival',
      'disassembly_defect',
      'ukladka',
      'sborka',
      'obkatka',
      'otk',
      'shipped',
      'accepted',
      'scrap_branch',
    ]) {
      expect(CODES, `в наборе нет этапа '${code}'`).toContain(code);
    }
  });

  it('все этапы имеют непустые коды и названия', () => {
    for (const t of DEFAULT_REPAIR_STAGE_TEMPLATES) {
      expect(t.code.trim().length).toBeGreaterThan(0);
      expect(t.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('содержит «Укладка вала» с русским названием', () => {
    const ukl = DEFAULT_REPAIR_STAGE_TEMPLATES.find((t) => t.code === 'ukladka');
    expect(ukl?.name).toBe('Укладка вала');
  });
});
