import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Карточка сотрудника (аудит кнопок 10.10.2026, чинено по канону #1240):
// конъюнктивный гард пропускал ресид поверх правок при фоновом релоаде,
// ~15 saveAttr без проверки хоронили первую ошибку под черновиком,
// зеркало разделов перезагружало форму без dirty-check.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./EmployeeDetailsPage.tsx');

describe('карточка сотрудника бережёт введённое', () => {
  it('ресид не срабатывает поверх грязной карточки — гард не конъюнктивный', () => {
    expect(PAGE).toContain('if (dirtyRef.current) return;');
    expect(PAGE, 'конъюнкция снова пускает ресид поверх правок').not.toContain(
      'if (draftRestoredRef.current && dirtyRef.current) return;',
    );
  });

  it('saveAttr и saveAllAndClose возвращают успех — первая ошибка останавливает коммит', () => {
    expect(PAGE).toContain('async function saveAttr(code: string, value: unknown): Promise<boolean>');
    expect(PAGE).toContain('async function saveAllAndClose(): Promise<boolean>');
    expect(PAGE).toContain('if (!(await saveAttr(code, value))) return false;');
    expect(PAGE, 'закрытие мимо результата').toContain('saveAllAndClose().then((ok) => { if (ok) props.onClose(); })');
  });

  it('«Сброс» гасит dirty и чистит черновик ДО перезагрузки', () => {
    const norm = PAGE.split('\n')
      .map((line) => line.trim())
      .join('\n');
    const snippet = 'dirtyRef.current = false;\ncancelPendingDraftSave();\nawait clearDraft();';
    const hits = norm.split(snippet).length - 1;
    expect(hits, 'оба пути сброса (тулбар и close-actions) обязаны гасить dirty до ресида').toBe(2);
  });

  it('зеркало разделов не перезагружает грязную форму', () => {
    expect(PAGE).toContain('void loadAccountPerms();\n                  if (dirtyRef.current) return;\n                  void loadEmployee();');
  });

  it('роль пишется сразу (dirty не нужен), перевод помечает при добавлении', () => {
    // Роль — immediate-save селект: грязью не покрывается, т.к. записи нет в saveAll.
    expect(PAGE).toContain("await window.matrica.admin.users.update(props.employeeId, { role: nextRole })");
    // Черновые поля перевода эфемерны до «Добавить», а оно dirty ставит.
    const norm = PAGE.split('\n')
      .map((line) => line.trim())
      .join('\n');
    expect(norm).toContain('dirtyRef.current = true;\nsetTransfers(next);');
  });
});
