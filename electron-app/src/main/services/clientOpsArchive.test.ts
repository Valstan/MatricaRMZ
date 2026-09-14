import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sevenBin from '7zip-bin';
import { afterAll, describe, expect, it } from 'vitest';

import { readClientOpsArchive } from './clientOpsArchive.js';

/**
 * Читатель архива проверяется НА НАСТОЯЩЕМ архиве, собранном тем же 7za и теми же ключами, что
 * и боевой (`scripts/build-kaspersky-zip.mjs`). Готовый `build/kaspersky/*.zip` для этого не
 * годится: он в .gitignore и на чистом клоне его нет — тест бы «проходил», ничего не проверяя.
 *
 * Ради этого же здесь есть большой файл: маленькие строки deflate ужимает в ничто, и ошибку в
 * поточном шифре на длине в пару блоков не поймать.
 */
const PASSWORD = '111';
const stage = mkdtempSync(path.join(tmpdir(), 'client-ops-archive-test-'));
afterAll(() => rmSync(stage, { recursive: true, force: true }));

/**
 * Бинарь `7za` из `7zip-bin` приезжает в хранилище pnpm без бита запуска, и на Linux-раннере
 * `execFileSync` падает `EACCES` (локально на Windows этого не видно — там бита нет вовсе).
 * Ставим его сами: пропустить тест вместо этого нельзя — сторож, который «зелёный, потому что
 * не запустился», хуже отсутствующего.
 */
function seven(): string {
  chmodSync(sevenBin.path7za, 0o755);
  return sevenBin.path7za;
}

function buildArchive(files: Record<string, string | Buffer>, args: string[] = []): Buffer {
  const dir = mkdtempSync(path.join(stage, 'case-'));
  const inner = path.join(dir, 'kaspersky-matrica');
  mkdirSync(inner);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(inner, name), body);
  const zip = path.join(dir, 'out.zip');
  execFileSync(
    seven(),
    ['a', '-tzip', '-mem=ZipCrypto', `-p${PASSWORD}`, '-bso0', '-bsp0', ...args, zip, 'kaspersky-matrica'],
    { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return readFileSync(zip);
}

describe('readClientOpsArchive', () => {
  const big = Array.from({ length: 4000 }, (_, i) => `строка ${i} — кириллица и пробелы\r\n`).join('');
  const archive = buildArchive({
    'guide.ru.md': big,
    'lan-share-firewall.ps1': '# правило брандмауэра\r\nWrite-Host "ok"\r\n',
    'Запустить.cmd': '@echo off\r\n',
  });

  it('отдаёт все файлы, побайтово равные исходным', () => {
    const entries = readClientOpsArchive(archive, PASSWORD);
    const byName = new Map(entries.map((e) => [e.name, e.data]));
    expect([...byName.keys()].sort()).toEqual(['guide.ru.md', 'lan-share-firewall.ps1', 'Запустить.cmd'].sort());
    expect(byName.get('guide.ru.md')?.toString('utf8')).toBe(big);
    expect(byName.get('lan-share-firewall.ps1')?.toString('utf8')).toContain('правило брандмауэра');
  });

  it('снимает ведущий каталог архива — наружу уезжают плоские имена', () => {
    for (const entry of readClientOpsArchive(archive, PASSWORD)) {
      expect(entry.name).not.toContain('/');
    }
  });

  it('русское имя файла не превращается в кракозябры', () => {
    // 7za на русской Windows кладёт имена в cp866 и флаг UTF-8 не ставит. Вся ветка decodeName
    // существует ради этой строки — без неё файл лёг бы на диск нечитаемым именем.
    const names = readClientOpsArchive(archive, PASSWORD).map((e) => e.name);
    expect(names).toContain('Запустить.cmd');
  });

  it('читает и архив с именами в UTF-8 — на случай смены ключей сборщика', () => {
    const utf8 = buildArchive({ 'Запустить.cmd': '@echo off\r\n' }, ['-mcu=on']);
    expect(readClientOpsArchive(utf8, PASSWORD).map((e) => e.name)).toEqual(['Запустить.cmd']);
  });

  it('неверный пароль — внятная ошибка, а не мусор на диске', () => {
    expect(() => readClientOpsArchive(archive, '222')).toThrow(/пароль|контрольная сумма/i);
  });

  it('обрезанный архив не читается', () => {
    expect(() => readClientOpsArchive(archive.subarray(0, archive.length - 40), PASSWORD)).toThrow();
  });

  it('незашифрованный архив читается тоже — пароль тогда просто не нужен', () => {
    const dir = mkdtempSync(path.join(stage, 'plain-'));
    const inner = path.join(dir, 'kaspersky-matrica');
    mkdirSync(inner);
    writeFileSync(path.join(inner, 'README.md'), '# без пароля\r\n');
    const zip = path.join(dir, 'plain.zip');
    execFileSync(seven(), ['a', '-tzip', '-bso0', '-bsp0', zip, 'kaspersky-matrica'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const entries = readClientOpsArchive(readFileSync(zip), PASSWORD);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data.toString('utf8')).toContain('без пароля');
  });
});
