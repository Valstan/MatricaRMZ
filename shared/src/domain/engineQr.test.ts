import { describe, expect, it } from 'vitest';

import { parseEngineQrValue } from './engineQr.js';

describe('parseEngineQrValue', () => {
  it('бирка двигателя — id строчными', () => {
    expect(parseEngineQrValue('engine:8DC8D68A-3CB2-42E9-9565-F98D13C61E66')).toBe(
      '8dc8d68a-3cb2-42e9-9565-f98d13c61e66',
    );
  });

  it('чужое отбрасывается', () => {
    expect(parseEngineQrValue('')).toBeNull();
    expect(parseEngineQrValue(null)).toBeNull();
    expect(parseEngineQrValue('Д-001')).toBeNull();
    expect(parseEngineQrValue('engine:Д-001')).toBeNull();
    expect(parseEngineQrValue('engine:')).toBeNull();
    expect(parseEngineQrValue('contract:8dc8d68a-3cb2-42e9-9565-f98d13c61e66')).toBeNull();
    expect(parseEngineQrValue('engine:8dc8d68a-3cb2-42e9-XXXX-f98d13c61e66')).toBeNull();
    expect(parseEngineQrValue('  engine:8dc8d68a-3cb2-42e9-9565-f98d13c61e66  ')).toBe(
      '8dc8d68a-3cb2-42e9-9565-f98d13c61e66',
    );
  });
});
