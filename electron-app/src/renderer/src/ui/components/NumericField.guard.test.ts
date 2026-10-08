import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Числовое поле карточки коммитит на blur, а не на keystroke (09.10.2026): каждый
// keystroke поднимал setState карточки контракта с полным перерендером и тяжёлым
// эффектом прогресса, а промежуточные `""`/`"0."` схлопывались в `0`.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const FIELD = src('./NumericField.tsx');

describe('NumericField: черновик живёт в поле, коммит — на blur', () => {
  it('родителя дёргает только blur с распарсенным числом', () => {
    expect(FIELD).toContain('onBlur');
    expect(FIELD).toContain('props.onChange(n)');
    expect(FIELD, 'вернулся коммит на каждый keystroke — тормоза ввода тоже').not.toContain(
      'Number(e.target.value) || 0',
    );
  });

  it('мусор и пустота откатываются, а не превращаются в ноль', () => {
    expect(FIELD).toContain('useState<string | null>(null)');
    expect(FIELD).toContain('Number.isFinite(n)');
  });
});
