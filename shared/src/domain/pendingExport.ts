/**
 * Неотправленные данные, выгруженные в файл на машине оператора.
 *
 * Зачем: пересборка локальной базы (расхождение схемы с сервером) удаляет файл, поэтому
 * перед удалением неотправленные строки выгружаются в `pending-export-*.json` рядом с
 * базой. Дальше файл живёт своей жизнью: после первой успешной синхронизации реплей
 * возвращает строки в базу и **удаляет файл**, а если реплей прошёл частично — файл
 * остаётся, и данные, которых нет на сервере, лежат на диске тихо.
 *
 * Именно эта тишина и стоила оператору данных (жалоба 23.11.2026): у клиента внесено
 * много данных, они не уходят на сервер, и ни оператор, ни администратор об этом не
 * знают. Правило, которое отсюда следует: **пока файл-выгрузка лежит на машине, оператор
 * должен видеть об этом баннер** — иначе «неотправленные данные» равны «потерянные».
 *
 * Модуль без node/electron-импортов: его читают и главный процесс, и интерфейс.
 */

/** Разбор выгрузки по таблицам — видно, ЧТО именно не уехало. */
export type PendingExportTableStat = {
  /** Таблица реплики (`entities`, `attribute_values`, …). */
  table: string;
  /** Сколько строк в этой таблице. */
  n: number;
};

/** Один файл-выгрузка на машине. */
export type PendingExportFile = {
  /** Имя файла в папке данных программы — оператор отдаёт его администратору. */
  name: string;
  /** Сколько строк в файле. */
  rows: number;
  /** Когда выгружено (unix-мс); `null` — в файле нет отметки. */
  exportedAt: number | null;
  /** Почему выгружали: `schema_mismatch` / `ui` / `full_pull`; `null` — неизвестно. */
  reason: string | null;
};

/** Сводка по всем файлам-выгрузкам, лежащим на машине. */
export type PendingExportSummary = {
  /** Файлы-выгрузки. Пустой массив — неотправленных данных вне базы нет. */
  files: PendingExportFile[];
  /** Всего строк в них — это ровно те данные, которых на сервере нет. */
  rows: number;
  /** Потабличный разбор по всем файлам. */
  byTable: PendingExportTableStat[];
  /** Самая старая выгрузка (unix-мс) — с неё данные ждут. */
  oldestExportedAt: number | null;
  /** Причина последней выгрузки — по ней видно, что вызвало пересборку базы. */
  reason: string | null;
};

/** Причины выгрузки — как их видит оператор. */
export const PENDING_EXPORT_REASON_TEXT: Record<string, string> = {
  schema_mismatch: 'пересборка локальной базы: расхождение схемы с сервером',
  ui: 'сброс локальной базы по команде оператора',
  full_pull: 'полная загрузка прервалась, чтобы не потерять неотправленное',
};

/** Причина выгрузки словами; неизвестная — называется как есть, а не выдумывается. */
export function pendingExportReasonText(reason: string | null | undefined): string {
  const key = String(reason ?? '').trim();
  if (!key) return 'причина не указана';
  return PENDING_EXPORT_REASON_TEXT[key] ?? key;
}

const REPORT_TZ = 'Europe/Moscow';

function reportDateTime(ms: number | null | undefined): string {
  const ts = Number(ms);
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  try {
    return new Date(ts).toLocaleString('ru-RU', { timeZone: REPORT_TZ });
  } catch {
    return new Date(ts).toISOString();
  }
}

/**
 * Текст отчёта для администратора: что за данные, сколько их, в каком файле и куда их
 * девать. Отчёт **не отправляется на сервер сам** — данные лежат на машине оператора, и
 * администратору нужен сам файл; отчёт лишь объясняет, что прислать.
 *
 * Значений строк в отчёте нет (только имена файлов, таблицы и количества) — ПДн
 * оператора наружу не идут (D-041).
 */
export function formatPendingExportReport(args: {
  /** id машины. */
  clientId: string;
  summary: PendingExportSummary;
  /** Версия программы — по ней видно, старая ли сборка. */
  appVersion?: string | null;
  /** Когда отчёт снят (unix-мс). */
  detectedAt?: number;
}): string {
  const summary = args.summary;
  const now = Number(args.detectedAt ?? Date.now());
  const clientId = String(args.clientId ?? '').trim() || 'клиент неизвестен';
  const lines: string[] = [];

  lines.push('🚨 Матрица РМЗ: неотправленные данные лежат файлом на этой машине');
  lines.push(`Машина: ${clientId}`);
  lines.push(`Когда: ${reportDateTime(now)}`);
  lines.push(`Данные выгружены: ${reportDateTime(summary.oldestExportedAt)} — всего ${summary.rows} шт.`);
  lines.push(`Причина выгрузки: ${pendingExportReasonText(summary.reason)}`);
  lines.push('Что не уехало на сервер:');
  for (const row of [...summary.byTable].sort((a, b) => b.n - a.n)) {
    lines.push(`  • ${row.table}: ${row.n}`);
  }
  lines.push('Файлы (нужно приложить к отчёту):');
  for (const file of summary.files) {
    lines.push(`  • ${file.name} — ${file.rows} шт. (выгружен ${reportDateTime(file.exportedAt)})`);
  }
  const version = String(args.appVersion ?? '').trim();
  if (version) lines.push(`Версия программы: ${version}`);
  lines.push(
    'Файл лежит в папке данных программы на этой машине (Проводник → AppData → MatricaRMZ). На сервере этих данных нет: пока файл не передан администратору, их не видит никто.',
  );
  return lines.join('\n');
}
