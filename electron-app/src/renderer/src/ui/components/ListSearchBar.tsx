// Bottom search bar for list pages (owner directive 2026-07-04): filters the
// displayed list to cards whose content matches. Pair with useListDeepFilter.
export function ListSearchBar(props: {
  query: string;
  onQueryChange: (q: string) => void;
  matched: number;
  total: number;
  placeholder?: string;
}) {
  const { query, onQueryChange, matched, total } = props;
  const active = query.trim().length > 0;
  return (
    <div
      data-testid="list-search-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        marginTop: 8,
        borderTop: '1px solid var(--border)',
        background: 'var(--surface)',
        position: 'sticky',
        bottom: 0,
        zIndex: 5,
      }}
    >
      <span aria-hidden style={{ color: 'var(--muted)', fontSize: 14 }}>🔍</span>
      <input
        data-testid="list-search-input"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && active) {
            e.stopPropagation();
            onQueryChange('');
          }
        }}
        placeholder={props.placeholder ?? 'Поиск в списке (и внутри карточек)…'}
        style={{
          flex: '1 1 auto',
          padding: '7px 10px',
          fontSize: 13,
          color: 'var(--text)',
          background: 'var(--input-bg, var(--surface2))',
          border: '1px solid var(--input-border, var(--border))',
          borderRadius: 8,
          outline: 'none',
        }}
      />
      <span style={{ flex: '0 0 auto', fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
        {active ? `${matched} из ${total}` : `${total}`}
      </span>
      {active ? (
        <button
          type="button"
          data-testid="list-search-clear"
          onClick={() => onQueryChange('')}
          title="Очистить (Esc)"
          style={{
            flex: '0 0 auto',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--muted)',
            borderRadius: 6,
            padding: '4px 8px',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
