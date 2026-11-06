import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Цепочка «архив → распаковка → окно» рвётся молча и целиком.
 *
 * Сборщик архива (`build-kaspersky-zip.mjs`) везёт ЯВНЫЙ список файлов. Забыли добавить в него
 * новый скрипт — архив соберётся зелёным, установщик уедет в парк, и только там выяснится, что
 * распаковывать нечего: клиент ищет точку входа, не находит и говорит «обновите клиент». Ни
 * один тест кода этого не заметит — всё дело в одной строке списка.
 *
 * Поэтому сторож сверяет три конца цепочки между собой: что клиент запускает, что сборщик
 * кладёт и что лежит в исходниках.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const srcDir = path.join(repoRoot, 'scripts', 'client-ops');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const BUILDER = read('electron-app/scripts/build-kaspersky-zip.mjs');
const SERVICE = read('electron-app/src/main/services/clientOpsService.ts');
const LAUNCHER = readFileSync(path.join(srcDir, 'matrica-ops.ps1'), 'utf8');

/** Имена из `const FILES = [...]` сборщика — единственный источник того, что уедет в парк. */
function builderFiles(): string[] {
  const block = BUILDER.match(/const FILES = \[([\s\S]*?)\]/);
  expect(block, 'в сборщике архива больше нет списка FILES — сторож ослеп').toBeTruthy();
  return [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/**
 * Файлы, которые сборщик берёт не из `scripts/client-ops`, а из другой папки репозитория
 * (сейчас — скрипт установки корня и публичная часть корня из `scripts/signing`).
 */
function extraSources(): Record<string, string> {
  const block = BUILDER.match(/const EXTRA_SOURCES = \{([\s\S]*?)\}/);
  expect(block, 'в сборщике больше нет EXTRA_SOURCES — сторож ослеп').toBeTruthy();
  const out: Record<string, string> = {};
  for (const m of block![1]!.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) out[m[1]!] = m[2]!;
  return out;
}

/** Где файл архива лежит в репозитории. */
function sourceFile(name: string): string {
  const extra = extraSources()[name];
  return extra ? path.join(repoRoot, extra) : path.join(srcDir, name);
}

describe('архив со скриптами обслуживания везёт всё, что нужно окну', () => {
  it('точка входа, которую запускает клиент, лежит в архиве', () => {
    // Имя живёт в двух файлах сразу: клиент его запускает, сборщик — кладёт.
    const entry = SERVICE.match(/const LAUNCHER_SCRIPT = '([^']+)'/)?.[1];
    expect(entry, 'в clientOpsService больше нет LAUNCHER_SCRIPT').toBeTruthy();
    expect(builderFiles(), `клиент запускает ${entry}, а сборщик его не кладёт`).toContain(entry);
  });

  it('окно обслуживания подключает утилиты, и все едут вместе с ним', () => {
    const files = builderFiles();
    for (const util of ['kaspersky-matrica.ps1', 'lan-share-firewall.ps1', 'opencode-cleanup.ps1']) {
      expect(LAUNCHER, `окно не подключает ${util}`).toContain(util);
      expect(files, `${util} не попадёт в архив — вкладка откроется с ошибкой`).toContain(util);
    }
    // Памятка рендерится из шаблона, и без него вкладка «Памятка» пуста.
    expect(files).toContain('guide.ru.md');
  });

  it('каждое имя из списка сборщика существует в исходниках', () => {
    for (const name of builderFiles()) {
      expect(existsSync(sourceFile(name)), `${name} в списке сборщика, но файла нет`).toBe(true);
    }
  });

  it('повышенный шаг установки корня едет в парк вместе с помощником', () => {
    // Шаг корня (ADR-0003) на машине парка выполнить нечем: репозитория там нет, а без
    // корня подпись клиента не действует — Касперский доверяет сертификату из МАШИННОГО
    // хранилища. Скрипт и публичная часть корня лежат в одной папке архива: скрипт ищет
    // .cer рядом с собой.
    const files = builderFiles();
    for (const name of ['install-root-on-machine.ps1', 'matrixarmz-rootca.cer']) {
      expect(files, `${name} не попадёт в архив — повышенный шаг на парке не выполнить`).toContain(
        name,
      );
    }
    const extra = extraSources();
    expect(extra['install-root-on-machine.ps1'], 'скрипт установки корня берётся не из того места').toBeTruthy();
    expect(extra['matrixarmz-rootca.cer'], 'публичная часть корня берётся не из того места').toBeTruthy();
  });

  it('утилиты умеют подключаться точкой — иначе дот-сорсинг откроет вторые окна', () => {
    for (const util of ['kaspersky-matrica.ps1', 'lan-share-firewall.ps1', 'opencode-cleanup.ps1']) {
      const text = readFileSync(path.join(srcDir, util), 'utf8');
      expect(text, `${util} потерял ключ -AsLibrary`).toContain('[switch]$AsLibrary');
      expect(text, `${util} не обрывает главный поток при -AsLibrary`).toContain('if ($AsLibrary) { return }');
    }
  });

  it('оба ярлыка запуска ведут в окно обслуживания, а не в старые отдельные окна', () => {
    for (const cmd of ['Запустить.cmd', 'Запустить-от-администратора.cmd']) {
      expect(readFileSync(path.join(srcDir, cmd), 'utf8'), `${cmd} ведёт мимо окна обслуживания`).toContain(
        'matrica-ops.ps1',
      );
    }
  });

  it('скрипты лежат в UTF-8 с BOM — без него PowerShell 5.1 читает их как ANSI', () => {
    // Кириллицы в этих файлах больше, чем кода: без BOM окно откроется с кракозябрами, а
    // сравнения путей с русскими именами начнут молча не совпадать.
    for (const name of builderFiles().filter((f) => f.endsWith('.ps1'))) {
      const head = readFileSync(sourceFile(name)).subarray(0, 3);
      expect([...head], `${name} без BOM`).toEqual([0xef, 0xbb, 0xbf]);
    }
  });
});
