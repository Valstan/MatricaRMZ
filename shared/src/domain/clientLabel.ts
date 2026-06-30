// Единый формат отображения клиента/рабочего места программы.
// Правило проекта: где бы ни показывался клиент — показывать логин + ФИО пользователя,
// а не только имя машины (имена машин владельцу ни о чём не говорят, людей он знает по логинам/ФИО).
// Использовать ВЕЗДЕ, где рендерится клиент: списки, диагностика, аудит, критические события.

export type ClientLabelParts = {
  clientId?: string | null;
  hostname?: string | null;
  /** Логин приложения (client_settings.lastUsername). */
  login?: string | null;
  /** ФИО, резолвится из employee по логину (full_name). */
  fullName?: string | null;
};

const UUID_SUFFIX = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Имя машины: hostname либо префикс client_id без хвостового UUID (PC41-… → PC41, DESKTOP-GZQVIFB-… → DESKTOP-GZQVIFB). */
export function clientMachineName(parts: ClientLabelParts): string {
  const host = (parts.hostname ?? '').trim();
  if (host) return host;
  const cid = (parts.clientId ?? '').trim();
  if (!cid) return '';
  return cid.replace(UUID_SUFFIX, '');
}

function person(parts: ClientLabelParts): string {
  const login = (parts.login ?? '').trim();
  const fullName = (parts.fullName ?? '').trim();
  if (fullName && login) return `${fullName} (${login})`;
  return fullName || login;
}

/** Полная метка: «Фатыхова Наталья Николаевна (fatyhova) · PC41». Без логина — только машина. */
export function formatClientLabel(parts: ClientLabelParts): string {
  const p = person(parts);
  const machine = clientMachineName(parts);
  if (p && machine) return `${p} · ${machine}`;
  if (p) return p;
  return machine || (parts.clientId ?? '').trim() || '—';
}

/** Короткая метка для узких колонок: «fatyhova · PC41» (ФИО — в тултип). Без логина — только машина. */
export function formatClientShort(parts: ClientLabelParts): string {
  const login = (parts.login ?? '').trim();
  const machine = clientMachineName(parts);
  if (login && machine) return `${login} · ${machine}`;
  if (login) return login;
  return machine || (parts.clientId ?? '').trim() || '—';
}
