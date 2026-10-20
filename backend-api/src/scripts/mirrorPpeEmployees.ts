/**
 * Зеркало справочника сотрудников (EAV `employee`) → строгие карточки СИЗ.
 *
 * Зачем: субъект «Кладовщика» — `erp_employee_cards`, а наполнял её только импорт
 * 1С:ЗУП. На проде импорт не запускался: 408 сотрудников в справочнике, карточек —
 * 0, пикеры СИЗ пусты. Скрипт — разовый бэкфилл и отчёт числами; дальше то же
 * зеркало крутится на primary каждые 5 минут (`startPpeEmployeeMirror`).
 *
 * Dry-run по умолчанию (ничего не пишет). `--apply` — записать.
 * Строки уезжают клиентам обычным путём зеркала (`ppeSyncPublisherService`).
 */
import { pool } from '../database/db.js';
import { mirrorPpeEmployees } from '../services/ppeEmployeeMirror.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  const report = await mirrorPpeEmployees({ apply: APPLY });
  console.log(APPLY ? 'РЕЖИМ: применено' : 'РЕЖИМ: dry-run (ничего не записано; добавьте --apply)');
  console.log(`Сотрудников в справочнике: ${report.employees}`);
  console.log(
    `Карточки: создать ${report.created}, обновить ${report.updated}, вернуть ${report.restored}, ` +
      `погасить ${report.deleted}, без изменений ${report.untouched}`,
  );
  if (report.ambiguous.length > 0) {
    console.log(`Не сведено однозначно: ${report.ambiguous.length}`);
    for (const row of report.ambiguous.slice(0, 50)) {
      console.log(`  ${row.entityId} ${row.fullName || ''} — ${row.reason}`);
    }
    if (report.ambiguous.length > 50) console.log(`  … и ещё ${report.ambiguous.length - 50}`);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error('Зеркало упало:', e);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
