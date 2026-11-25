import type { SearchFieldMatch } from '@matricarmz/shared';

/**
 * Бейдж «по какому полю совпала строка» (промт КАРМАНА #137, 25.11.2026).
 *
 * Показывается только когда идёт поиск и строка нашлась: без запроса бейдж был бы
 * шумом. Если совпало несколько полей, показывается ПЕРВОЕ по приоритету реестра —
 * так же, как строка попадает в группу палитры.
 */
export function SearchMatchBadge(props: { matches?: SearchFieldMatch[] | undefined }) {
  const matches = props.matches ?? [];
  if (matches.length === 0) return null;
  const primary = matches[0]!;
  return (
    <span
      data-testid="search-match-badge"
      title={`Найдено по полю «${primary.label}»`}
      style={{
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 8,
        background: 'rgba(37, 99, 235, 0.12)',
        color: '#1d4ed8',
        whiteSpace: 'nowrap',
      }}
    >
      по {primary.label}
    </span>
  );
}
