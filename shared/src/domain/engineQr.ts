/**
 * QR бирки двигателя: `engine:<uuid>` — тот же формат, что ключ ссылки приложения
 * (`desktopShortcutLinkKey`). Номер для навигации не годится (повторный заезд даёт
 * тот же номер дважды), голый uuid неотличим от QR номенклатуры.
 */

const ENGINE_QR_RE = /^engine:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** id двигателя из текста QR бирки; null — это не бирка (чужой QR, опечатка скана). */
export function parseEngineQrValue(text: unknown): string | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const m = ENGINE_QR_RE.exec(raw);
  return m?.[1] ? String(m[1]).toLowerCase() : null;
}
