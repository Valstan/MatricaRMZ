import { describe, expect, it } from 'vitest';

import { normalizeOpencodeNodes, OPENCODE_DEFAULT_PORT } from './opencodeNodes.js';

describe('normalizeOpencodeNodes', () => {
  it('возвращает [] на не-массиве', () => {
    expect(normalizeOpencodeNodes(null)).toEqual([]);
    expect(normalizeOpencodeNodes({})).toEqual([]);
    expect(normalizeOpencodeNodes('x')).toEqual([]);
  });

  it('подставляет схему и порт по умолчанию', () => {
    const rows = normalizeOpencodeNodes([{ name: 'pc79', url: '192.168.1.10' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe(`http://192.168.1.10:${OPENCODE_DEFAULT_PORT}/`);
    expect(rows[0]?.name).toBe('pc79');
  });

  it('имя по умолчанию — hostname, явный порт не затирается', () => {
    const rows = normalizeOpencodeNodes([{ url: 'http://srv:4000/serve' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('srv');
    expect(rows[0]?.url).toBe('http://srv:4000/serve');
  });

  it('отбрасывает битое и дедуплицирует по url', () => {
    const rows = normalizeOpencodeNodes([
      { name: 'a', url: 'http://h:3080/' },
      { name: 'b', url: 'h' },
      { name: 'c', url: 'ftp://h/x' },
      { name: '', url: '' },
      null,
      'str',
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ name: 'a', url: 'http://h:3080/' });
  });
});
