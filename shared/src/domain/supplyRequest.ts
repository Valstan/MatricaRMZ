export type SupplyRequestStatus =
  | 'draft'
  | 'signed'
  | 'director_approved'
  | 'accepted'
  | 'fulfilled_full'
  | 'fulfilled_partial';

export type SupplyRequestTransitionAction =
  | 'sign'
  | 'director_approve'
  | 'accept'
  | 'fulfill_full'
  | 'fulfill_partial';

export type SupplyRequestDelivery = {
  deliveredAt?: number; // ms epoch
  qty?: number;
  note?: string | null;
};

export type DefectOrigin = {
  engineId: string;
  conductedVersionId: string;
  sourceLineIds: string[];
};

export type SupplyRequestItem = {
  lineNo?: number;
  productId?: string | null;
  name?: string;
  qty?: number;
  unit?: string;
  note?: string | null;
  deliveries?: SupplyRequestDelivery[];
  defectOrigin?: DefectOrigin;
};

export type SupplyRequestSignature = {
  userId?: string | null;
  username?: string | null;
  fullName?: string | null;
  position?: string | null;
  signedAt: number; // ms epoch
};

export type SupplyRequestAuditTrailItem = {
  at: number;
  by: string; // username
  action: string;
  note?: string | null;
};

import type { FileRef } from './fileStorage.js';

export type SupplyRequestPayload = {
  kind: 'supply_request';
  version: 2;

  // identity
  operationId: string; // operations.id
  requestNumber: string;

  // header
  compiledAt: number; // дата составления
  sentAt?: number | null; // дата отправки заявки
  acceptedAt?: number | null; // дата принятия снабжением
  expectedDeliveryAt?: number | null; // ожидаемая дата поставки (для прогноза сборки)
  arrivedAt?: number | null; // дата поступления деталей на завод
  fulfilledAt?: number | null; // дата исполнения

  title: string;
  status: SupplyRequestStatus;

  // org links (master-data ids)
  departmentId: string;
  workshopId?: string | null;
  sectionId?: string | null;

  // items
  items: SupplyRequestItem[];

  // attachments
  attachments?: FileRef[];

  // signatures / workflow
  signedByHead?: SupplyRequestSignature | null;
  approvedByDirector?: SupplyRequestSignature | null;
  acceptedBySupply?: SupplyRequestSignature | null;

  auditTrail?: SupplyRequestAuditTrailItem[];
};

/**
 * «Пустая» заявка снабжения — авто-созданная карточка без содержимого: нет позиций,
 * вложений и заголовка. Номер/дата проставляются автоматически и содержимым не считаются.
 * Defensive: принимает сырой payload — используется чисткой пустых карточек на бэкенде.
 */
export type SupplyIncomingLine = {
  productId: string;
  orderedQty: number;
  deliveredQty: number; // сумма поставок (deliveries) по позиции
  expectedAt: number; // ms epoch
};

/**
 * Ф2 (G4): заявки снабжения → канал будущего прихода прогноза сборки.
 * Считаются только заявки, принятые снабжением (`accepted` / `fulfilled_partial`) и с заполненной
 * «ожидаемой датой поставки»: до принятия закупка не подтверждена, без даты позицию некуда
 * поставить на таймлайн. Позиции без `productId` пропускаются (нечего матчить с номенклатурой).
 * Заказано/привезено отдаются раздельно (включая полностью привезённые позиции): остаток считает
 * вызывающий как `ordered − max(delivered, received)` — привезённое по deliveries и оформленный
 * приход на склад описывают одни и те же физические поставки, вычитать их суммой нельзя
 * (см. warehouseForecastService).
 */
export function buildSupplyIncomingFromRequestPayloads(payloads: unknown[]): SupplyIncomingLine[] {
  const out: SupplyIncomingLine[] = [];
  for (const raw of payloads) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const p = raw as Record<string, unknown>;
    if (p.kind !== 'supply_request') continue;
    const status = String(p.status ?? '');
    if (status !== 'accepted' && status !== 'fulfilled_partial') continue;
    const expectedAt = Number(p.expectedDeliveryAt);
    if (!Number.isFinite(expectedAt) || expectedAt <= 0) continue;
    const items = Array.isArray(p.items) ? p.items : [];
    for (const itRaw of items) {
      if (!itRaw || typeof itRaw !== 'object') continue;
      const it = itRaw as Record<string, unknown>;
      const productId = String(it.productId ?? '').trim();
      if (!productId) continue;
      const ordered = Math.max(0, Math.floor(Number(it.qty ?? 0)));
      if (ordered <= 0) continue;
      const deliveries = Array.isArray(it.deliveries) ? it.deliveries : [];
      const delivered = deliveries.reduce((acc: number, d) => {
        const q = d && typeof d === 'object' ? Number((d as Record<string, unknown>).qty ?? 0) : 0;
        return acc + (Number.isFinite(q) && q > 0 ? q : 0);
      }, 0);
      out.push({ productId, orderedQty: ordered, deliveredQty: Math.floor(delivered), expectedAt });
    }
  }
  return out;
}

export function isSupplyRequestPayloadEmpty(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true;
  const p = payload as Record<string, unknown>;
  const items = Array.isArray(p.items) ? p.items.length : 0;
  const attachments = Array.isArray(p.attachments) ? p.attachments.length : 0;
  const hasTitle = typeof p.title === 'string' && p.title.trim() !== '';
  return items === 0 && attachments === 0 && !hasTitle;
}


