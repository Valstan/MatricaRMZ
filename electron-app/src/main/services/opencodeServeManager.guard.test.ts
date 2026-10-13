import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const MANAGER = src('./opencodeServeManager.ts');
const INDEX = src('../index.ts');
const NSIS = src('../../../installer/installer.nsh');
const PAGE = src('../../renderer/src/ui/pages/OpenCodeNodesPage.tsx');
const KASPERSKY = src('../../../../scripts/client-ops/kaspersky-matrica.ps1');
const OPENCODE_LOOPBACK_MARKER = "'--hostname', OPENCODE_LOOPBACK_HOST";

// Узел ведёт сам клиент (план opencode-native-2026-10): per-user каталог без админа,
// serve только на loopback (без правил брандмауэра), наружу — релеем exe Матрицы.
// Рвётся молча: установщик снова зовёт админ-скрипт; serve слушает сеть; клиент
// не стартует/не гасит узел; Касперский ест неподписанный exe.
describe('opencode-узел нативно в клиенте', () => {
  it('serve слушает только loopback — нового порта в LAN нет', () => {
    expect(MANAGER).toContain(OPENCODE_LOOPBACK_MARKER);
    expect(MANAGER, 'serve снова на всех интерфейсах — нужно правило брандмауэра и админ').not.toContain('0.0.0.0');
  });

  it('установщик не ставит узел: per-user без UAC задачи и правила не создать', () => {
    expect(NSIS, 'админ-установка вернулась в per-user установщик').not.toContain('InstallOpencode');
    expect(NSIS, 'установщик снова тянет harness').not.toContain('opencode-harness.ps1');
  });

  it('клиент стартует узел фоном после окна и гасит на выходе', () => {
    expect(INDEX, 'узел не стартует — после переустановки serve молчит').toContain('void ensureOpencodeNode()');
    expect(INDEX, 'узел переживает выход — висит сиротой').toContain('void stopOpencodeNode()');
  });

  it('раздел показывает состояние локального узла, а не только реестр', () => {
    expect(PAGE, 'нет строки локального узла — оператор не видит, что ставится').toContain('data-opencode-local-status');
    expect(PAGE).toContain('window.matrica.opencodeNodes.status()');
  });

  it('папка узла — в плане исключений Касперского (та же процедура импорта)', () => {
    expect(KASPERSKY, 'папка узла не в исключениях — эвристика съест exe').toContain('OpencodeDir');
  });
});
