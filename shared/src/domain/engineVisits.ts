// ЗАЕЗДЫ ДВИГАТЕЛЯ КАК СУЩНОСТЬ (владелец 20.11.2026).
//
// «История заезда двигателя с одним и тем же номером, скорее всего, лучше заносить в
// одну и ту же карточку двигателя: сделать вкладку „История заездов“ и хранить данные
// там. Но в каждом заезде могут быть разные договоры, разные поставщики и заказчики —
// поэтому по каждому заезду это заполняется отдельно.» (промт КАРМАНА #42)
//
// Позже владелец уточнил, как это должно выглядеть: «сделать заезды в виде разделов во
// вкладке „Основное“, там как бы раскрывающиеся разделы „Заезд 1“, Заезд 2 и так далее,
// самые свежие последние заезды самые верхние… рекламации пусть на голубоватом фоне,
// история ремонта показывается от прихода до отгрузки, а остальные заезды, ну самый
// свежий заезд на белом фоне, а чем старее заезд тем как бы серее и коричневее фон».
//
// Здесь — правила, которые обязаны быть одними и в интерфейсе, и в фильтрах, и в
// отчётах: какой заезд считается ТЕКУЩИМ, какой ПРОШЛЫМ, в какой заезд попадает строка
// истории ремонта и каким тоном показывается заезд. Если это правило живёт в двух
// местах, «движок сейчас на заводе» и «история по заездам» разъедутся.

import type { EngineVisit } from './engineReclamations.js';

/** Роль заезда: `current` — движок на нём сейчас; `past` — заезд уже закрыт. */
export type EngineVisitRole = 'current' | 'past';

/**
 * Тон заезда — фон раздела. Чем старше заезд, тем темнее и «старше» фон; рекламационные
 * заезды — голубоватые (владелец 20.11.2026), и тон по возрасту их не перебивает:
 * рекламация — это другое событие, а не «просто более старый заезд».
 */
export type EngineVisitTone = 'current' | 'aged-1' | 'aged-2' | 'aged-3' | 'reclamation';

/** Заезд в том виде, в каком его видит интерфейс (раздел карточки). */
export type EngineVisitView = {
  /** Номер по свежести: 1 — самый свежий (текущий), 2 и дальше — прошлые. */
  no: number;
  /** Сквозной номер в истории: 1 — самый первый заезд (основной цикл). */
  visitNo: number;
  kind: 'main' | 'reclamation' | 'archived';
  role: EngineVisitRole;
  /** Заезд по рекламации (возврат двигателя). */
  isReclamation: boolean;
  arrivalDate: number | null;
  shippingDate: number | null;
  contractId: string | null;
  customerId: string | null;
  arrivalInvoice: string | null;
  shipmentInvoice: string | null;
  /** Подпись раздела: «Заезд 1 · текущий». */
  title: string;
  /** Подпись под видом заезда: «основной цикл» / «рекламация №1». */
  subtitle: string;
  tone: EngineVisitTone;
};

/** Фоны разделов: свежий — белый, дальше — сепия, желтизна, тёмная «старина». */
export const ENGINE_VISIT_TONE_BACKGROUNDS: Record<EngineVisitTone, string> = {
  current: 'rgba(255, 255, 255, 0)',
  'aged-1': 'rgba(122, 112, 96, 0.10)',
  'aged-2': 'rgba(163, 128, 58, 0.14)',
  'aged-3': 'rgba(84, 58, 32, 0.20)',
  reclamation: 'rgba(37, 99, 235, 0.10)',
};

export function engineVisitToneBackground(tone: EngineVisitTone): string {
  return ENGINE_VISIT_TONE_BACKGROUNDS[tone] ?? ENGINE_VISIT_TONE_BACKGROUNDS.current;
}

function dateMs(value: number | null | undefined): number | null {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Разделы заездов: свежие сверху, прошлые — ниже и темнее.
 *
 * Порядок — по дате прихода; заезд без даты прихода уходит в конец (он «не начался»).
 * Текущим считается ПОСЛЕДНИЙ по дате заезд: пока движок не приехал заново, его прошлый
 * заезд остаётся текущим, и наоборот — вернувшийся по рекламации движок открывает
 * новый заезд, а прежний становится прошлым.
 */
export function buildEngineVisitViews(visits: readonly EngineVisit[]): EngineVisitView[] {
  const ordered = [...(visits ?? [])]
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      const da = dateMs(a.v.arrivalDate);
      const db = dateMs(b.v.arrivalDate);
      if (da == null && db == null) return a.i - b.i;
      if (da == null) return 1;
      if (db == null) return -1;
      return da - db || a.i - b.i;
    })
    .map((x) => x.v);

  const total = ordered.length;
  const views: EngineVisitView[] = [];
  ordered.forEach((v, idx) => {
    // Свежесть: 0 — самый свежий заезд (последний по дате).
    const age = total - 1 - idx;
    const isReclamation = v.kind === 'reclamation';
    const role: EngineVisitRole = age === 0 ? 'current' : 'past';
    const tone: EngineVisitTone = isReclamation ? 'reclamation' : age === 0 ? 'current' : age === 1 ? 'aged-1' : age === 2 ? 'aged-2' : 'aged-3';
    const subtitle = isReclamation ? `рекламация №${v.visitNo - 1}` : v.kind === 'archived' ? 'прежний заезд' : 'основной цикл';
    views.push({
      no: age + 1,
      visitNo: v.visitNo,
      kind: v.kind,
      role,
      isReclamation,
      arrivalDate: v.arrivalDate,
      shippingDate: v.shippingDate,
      contractId: v.contractId,
      customerId: v.customerId,
      arrivalInvoice: v.arrivalInvoice,
      shipmentInvoice: v.shipmentInvoice,
      title: `Заезд ${age + 1}`,
      subtitle,
      tone,
    });
  });
  // Порядок выдачи — СВЕЖИЕ СВЕРХУ (владелец 20.11.2026: «самые свежие последние
  // заезды самые верхние»). Сквозной номер `visitNo` при этом остаётся прежним: 1 —
  // самый первый заезд, его знают отчёты.
  return views.sort((a, b) => a.no - b.no);
}

/** Текущий заезд — самый свежий (последний по дате прихода). */
export function currentEngineVisit(views: readonly EngineVisitView[]): EngineVisitView | null {
  return views.find((v) => v.role === 'current') ?? null;
}

/**
 * Раздаёт строки истории ремонта по заездам: событие относится к тому заезду, который
 * к этому моменту шёл — то есть к последнему начавшемуся.
 *
 * Границы заезда: от его прихода и до прихода следующего. Верхняя граница по отгрузке
 * («история ремонта от прихода до отгрузки») не режет строки: строка после отгрузки
 * этого заезда и до следующего прихода остаётся в нём же — иначе она пропала бы из
 * истории (а потерянная строка истории хуже лишней строки в соседнем заезде).
 */
export function splitEngineHistoryByVisits<T extends { at: number }>(
  items: readonly T[],
  views: readonly EngineVisitView[],
): Map<number, T[]> {
  const ordered = [...(views ?? [])].sort((a, b) => {
    const da = dateMs(a.arrivalDate);
    const db = dateMs(b.arrivalDate);
    if (da == null && db == null) return a.visitNo - b.visitNo;
    if (da == null) return 1;
    if (db == null) return -1;
    return da - db || a.visitNo - b.visitNo;
  });
  const out = new Map<number, T[]>();
  for (const v of ordered) out.set(v.visitNo, []);
  if (ordered.length === 0) return out;

  for (const item of items ?? []) {
    const at = Number(item?.at ?? 0);
    let target: EngineVisitView | null = null;
    for (const v of ordered) {
      const from = dateMs(v.arrivalDate);
      if (from == null) continue;
      if (at < from) continue;
      target = v;
    }
    if (!target) {
      // Событие раньше первого прихода — в первый заезд (обычно основной цикл).
      target = ordered[0] ?? null;
    }
    if (!target) continue;
    const bucket = out.get(target.visitNo);
    if (bucket) bucket.push(item);
  }
  return out;
}
