import { describe, expect, it } from 'vitest';

import {
  PASTABLE_FILE_DIALOG_FILTERS,
  classifyPastableFile,
  decodeTextBytes,
  unsupportedPastableFileMessage,
} from './pastableFile.js';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('classifyPastableFile', () => {
  it('reads plain text formats as text', () => {
    expect(classifyPastableFile('письмо.txt')).toBe('text');
    expect(classifyPastableFile('замеры.csv')).toBe('text');
    expect(classifyPastableFile('выгрузка.tsv')).toBe('text');
    expect(classifyPastableFile('заметка.log')).toBe('text');
  });

  it('reads docx as docx', () => {
    expect(classifyPastableFile('акт исследования.docx')).toBe('docx');
  });

  it('ignores letter case of the extension', () => {
    expect(classifyPastableFile('АКТ.DOCX')).toBe('docx');
    expect(classifyPastableFile('ПИСЬМО.TXT')).toBe('text');
  });

  it('takes the last extension of a multi-dot name', () => {
    expect(classifyPastableFile('акт.от.05.09.docx')).toBe('docx');
  });

  it('rejects the old binary .doc — it is not a zip and text cannot be taken from it', () => {
    expect(classifyPastableFile('акт.doc')).toBe('unsupported');
  });

  it('rejects everything else', () => {
    expect(classifyPastableFile('скан.pdf')).toBe('unsupported');
    expect(classifyPastableFile('фото.jpg')).toBe('unsupported');
    expect(classifyPastableFile('таблица.xlsx')).toBe('unsupported');
    expect(classifyPastableFile('файл_без_расширения')).toBe('unsupported');
    expect(classifyPastableFile('')).toBe('unsupported');
  });

  it('handles a full path, not only a bare name', () => {
    expect(classifyPastableFile('D:\\Документы\\акт.docx')).toBe('docx');
    expect(classifyPastableFile('/home/u/письмо.txt')).toBe('text');
  });
});

describe('unsupportedPastableFileMessage', () => {
  it('names the offending extension and the supported ones', () => {
    const msg = unsupportedPastableFileMessage('скан.pdf');
    expect(msg).toContain('.pdf');
    expect(msg).toContain('.txt');
    expect(msg).toContain('.docx');
  });

  it('tells the operator what to do with an old .doc instead of just refusing', () => {
    const msg = unsupportedPastableFileMessage('акт.doc');
    expect(msg).toContain('.docx');
    expect(msg.toLowerCase()).toContain('сохран');
  });

  it('stays readable when the file has no extension at all', () => {
    const msg = unsupportedPastableFileMessage('акт_без_расширения');
    expect(msg.trim()).not.toBe('');
    expect(msg).toContain('.docx');
  });
});

describe('decodeTextBytes', () => {
  it('reads utf-8', () => {
    expect(decodeTextBytes(utf8('Задир шейки вала'))).toBe('Задир шейки вала');
  });

  it('strips the utf-8 byte order mark', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('Акт')]);
    expect(decodeTextBytes(withBom)).toBe('Акт');
  });

  it('reads utf-16 with a byte order mark', () => {
    const le = new Uint8Array([0xff, 0xfe, 0x10, 0x04, 0x3a, 0x04, 0x42, 0x04]);
    expect(decodeTextBytes(le)).toBe('Акт');
  });

  // Заводские .txt почти всегда в CP1251: без этого оператор вставил бы кракозябры.
  it('falls back to windows-1251 when the bytes are not valid utf-8', () => {
    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    expect(decodeTextBytes(cp1251)).toBe('Привет');
  });

  it('keeps plain ascii identical either way', () => {
    expect(decodeTextBytes(new Uint8Array([0x41, 0x42, 0x43]))).toBe('ABC');
  });

  it('returns an empty string for empty input', () => {
    expect(decodeTextBytes(new Uint8Array([]))).toBe('');
  });

  it('normalises line endings to line feeds', () => {
    expect(decodeTextBytes(utf8('А\r\nБ\rВ'))).toBe('А\nБ\nВ');
  });
});

describe('PASTABLE_FILE_DIALOG_FILTERS', () => {
  it('offers a combined filter first so the operator sees every suitable file at once', () => {
    const first = PASTABLE_FILE_DIALOG_FILTERS[0];
    expect(first?.extensions).toContain('txt');
    expect(first?.extensions).toContain('docx');
  });

  it('never offers an extension the reader cannot actually handle', () => {
    for (const filter of PASTABLE_FILE_DIALOG_FILTERS) {
      for (const ext of filter.extensions) {
        expect(classifyPastableFile(`file.${ext}`)).not.toBe('unsupported');
      }
    }
  });
});
