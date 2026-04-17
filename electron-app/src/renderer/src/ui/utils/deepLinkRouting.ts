import type { ChatDeepLinkPayload } from '@matricarmz/shared';

export type DeepLinkRoute =
  | { kind: 'engine'; id: string }
  | { kind: 'request'; id: string }
  | { kind: 'part'; id: string }
  | { kind: 'tool'; id: string }
  | { kind: 'tool_property'; id: string }
  | { kind: 'contract'; id: string }
  | { kind: 'employee'; id: string }
  | { kind: 'product'; id: string }
  | { kind: 'service'; id: string }
  | { kind: 'counterparty'; id: string }
  | { kind: 'nomenclature'; id: string }
  | { kind: 'stock_document'; id: string }
  | { kind: 'engine_brand'; id: string }
  | { kind: 'report_preset'; id: string }
  | { kind: 'tab'; id: string };

function asId(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}

export function resolveDeepLinkRoute(link: ChatDeepLinkPayload): DeepLinkRoute {
  const pairs: Array<[DeepLinkRoute['kind'], string | null]> = [
    ['engine', asId(link?.engineId)],
    ['request', asId(link?.requestId)],
    ['part', asId(link?.partId)],
    ['tool', asId(link?.toolId)],
    ['tool_property', asId(link?.toolPropertyId)],
    ['contract', asId(link?.contractId)],
    ['employee', asId(link?.employeeId)],
    ['product', asId(link?.productId)],
    ['service', asId(link?.serviceId)],
    ['counterparty', asId(link?.counterpartyId)],
    ['nomenclature', asId(link?.nomenclatureId)],
    ['stock_document', asId(link?.stockDocumentId)],
    ['engine_brand', asId(link?.engineBrandId)],
    ['report_preset', asId(link?.reportPresetId)],
  ];
  for (const [kind, id] of pairs) {
    if (id) return { kind, id } as DeepLinkRoute;
  }
  return { kind: 'tab', id: String(link?.tab ?? '') };
}
