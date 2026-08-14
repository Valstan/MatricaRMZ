import type { ChatDeepLinkPayload } from '@matricarmz/shared';

const PREFIX = 'favorite:';

type FavoritePayload = { title: string; link: ChatDeepLinkPayload };

export function buildFavoriteShortcut(tab: string, entityId: string, title: string): string | null {
  const safeTab = String(tab ?? '').trim();
  const safeId = String(entityId ?? '').trim();
  const safeTitle = String(title ?? '').trim().slice(0, 140);
  if (!safeTab || !safeId || !safeTitle) return null;
  const link = {
    kind: 'app_link',
    tab: safeTab,
    cardKind: safeTab,
    entityId: safeId,
    breadcrumbs: [safeTitle],
  } as ChatDeepLinkPayload;
  return `${PREFIX}${encodeURIComponent(JSON.stringify({ title: safeTitle, link } satisfies FavoritePayload))}`;
}

export function parseFavoriteShortcut(value: string): FavoritePayload | null {
  const source = String(value ?? '').trim();
  if (!source.toLowerCase().startsWith(PREFIX)) return null;
  try {
    const raw = JSON.parse(decodeURIComponent(source.slice(PREFIX.length))) as Partial<FavoritePayload>;
    const title = String(raw.title ?? '').trim();
    const link = raw.link;
    if (!title || !link || link.kind !== 'app_link' || typeof link.tab !== 'string') return null;
    return { title, link };
  } catch {
    return null;
  }
}
