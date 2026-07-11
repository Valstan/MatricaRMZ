import React, { useCallback, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';

// Т2 (docs/plans/parts-articul-acts-2026-06.md): операторский модуль поиска и
// слияния дублей номенклатуры (деталей). Анализ — на сервере (точные пары
// название+артикул и fuzzy-кандидаты); решение о слиянии всегда за оператором:
// он отмечает галочками, ЧТО объединять, и выбирает главную деталь (survivor).

type DedupeUsage = {
  stockBalances: number;
  stockMovements: number;
  bomLines: number;
  docLines: number;
  brandLinks: number;
  hasNomenclature: boolean;
};

type DedupePart = {
  id: string;
  name: string;
  code: string | null;
  isActive: boolean;
  createdAt: number;
  usage: DedupeUsage;
};

type DedupeKind = 'exact' | 'code-collision' | 'fuzzy';
type DedupeGroup = { kind: DedupeKind; parts: DedupePart[] };

const GROUP_STYLE: Record<DedupeKind, { border: string; background: string; color: string; title: string }> = {
  exact: {
    border: '#fca5a5',
    background: 'rgba(254, 226, 226, 0.35)',
    color: '#b91c1c',
    title: '🔴 Жёсткий дубль (название + артикул совпадают)',
  },
  'code-collision': {
    border: '#fdba74',
    background: 'rgba(255, 237, 213, 0.5)',
    color: '#b45309',
    title: '🟠 Коллизия артикула (одинаковый код, разные названия) — слить ИЛИ исправить код',
  },
  fuzzy: {
    border: '#cbd5e1',
    background: 'transparent',
    color: '#334155',
    title: '🟡 Похожие (кандидаты)',
  },
};

type MergeReport = {
  survivorId: string;
  merged: Array<{
    loserId: string;
    repointed: { stockBalances: number; stockMovements: number; bomLines: number; docLines: number; operations: number };
    bomLinesDropped: number;
    brandLinksAdded: number;
  }>;
  fills: string[];
  conflicts: string[];
};

function usageScore(u: DedupeUsage): number {
  return u.stockBalances + u.stockMovements + u.bomLines + u.docLines + u.brandLinks + (u.hasNomenclature ? 1 : 0);
}

function usageLabel(u: DedupeUsage): string {
  const parts: string[] = [];
  if (u.stockBalances) parts.push(`остатки: ${u.stockBalances}`);
  if (u.stockMovements) parts.push(`движения: ${u.stockMovements}`);
  if (u.bomLines) parts.push(`BOM: ${u.bomLines}`);
  if (u.docLines) parts.push(`документы: ${u.docLines}`);
  if (u.brandLinks) parts.push(`марки: ${u.brandLinks}`);
  if (!u.hasNomenclature) parts.push('без складской карточки');
  return parts.length ? parts.join(' · ') : 'не используется';
}

export function PartsDedupePage(props: { canEdit: boolean }) {
  const { confirm } = useConfirm();
  const [groups, setGroups] = useState<DedupeGroup[] | null>(null);
  const [totalParts, setTotalParts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // selection per group index: checked part ids + survivor id
  const [checked, setChecked] = useState<Record<number, Record<string, boolean>>>({});
  const [survivors, setSurvivors] = useState<Record<number, string>>({});
  const [lastReport, setLastReport] = useState<MergeReport | null>(null);

  // Намеренно НЕ чистим lastReport: после merge сразу запускается повторный анализ,
  // и баннер «Слияние выполнено» должен пережить его (иначе оператор не видит отчёт).
  const analyze = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const r = await (window.matrica.warehouse as any).partsDedupeAnalyze();
      if (!r?.ok) {
        setError(String(r?.error ?? 'не удалось выполнить анализ'));
        setGroups(null);
        return;
      }
      const nextGroups = (r.groups ?? []) as DedupeGroup[];
      setGroups(nextGroups);
      setTotalParts(Number(r.totalParts ?? 0));
      const nextChecked: Record<number, Record<string, boolean>> = {};
      const nextSurvivors: Record<number, string> = {};
      nextGroups.forEach((g, idx) => {
        const sel: Record<string, boolean> = {};
        // «жёсткие» дубли по ключу — отмечены сразу; fuzzy-кандидаты решает оператор
        for (const p of g.parts) sel[p.id] = g.kind === 'exact';
        nextChecked[idx] = sel;
        const best = [...g.parts].sort(
          (a, b) =>
            usageScore(b.usage) - usageScore(a.usage) ||
            Number(b.usage.hasNomenclature) - Number(a.usage.hasNomenclature) ||
            a.createdAt - b.createdAt,
        )[0];
        if (best) nextSurvivors[idx] = best.id;
      });
      setChecked(nextChecked);
      setSurvivors(nextSurvivors);
    } finally {
      setBusy(false);
    }
  }, []);

  const mergeGroup = useCallback(
    async (idx: number) => {
      const g = groups?.[idx];
      if (!g) return;
      const survivorId = survivors[idx] ?? '';
      const sel = checked[idx] ?? {};
      const mergedIds = g.parts.map((p) => p.id).filter((id) => sel[id] && id !== survivorId);
      if (!survivorId || mergedIds.length === 0) return;
      const survivor = g.parts.find((p) => p.id === survivorId);
      const names = g.parts
        .filter((p) => mergedIds.includes(p.id))
        .map((p) => `«${p.name}»${p.code ? ` (арт. ${p.code})` : ''}`)
        .join(', ');
      // Общий артикул у РАЗНЫХ названий — санкционированная модель (напр. «Картер верхний»
      // и «Картер нижний» с одним артикулом 3301-15-30): такое слияние «удаляет» одну из
      // реально разных деталей (инцидент 2026-06-19). Предупреждаем отдельно.
      const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
      const differentNames = survivor
        ? g.parts.filter((p) => mergedIds.includes(p.id) && norm(p.name) !== norm(survivor.name))
        : [];
      const differentNamesWarning =
        differentNames.length > 0
          ? `\n\n⚠️ НАЗВАНИЯ РАЗЛИЧАЮТСЯ: ${differentNames.map((p) => `«${p.name}»`).join(', ')} ≠ «${survivor?.name ?? ''}». ` +
            'Один артикул у разных названий может означать РАЗНЫЕ детали (например, картер верхний и нижний) — тогда сливать нельзя, надо исправить артикул у одной из них.'
          : '';
      const ok = await confirm({
        title: 'Объединить детали?',
        detail: `${names} будут слиты в «${survivor?.name ?? ''}»${survivor?.code ? ` (арт. ${survivor.code})` : ''}. Все остатки, движения, спецификации и строки актов перевесятся на главную деталь; поглощаемые будут помечены удалёнными. Действие необратимо.${differentNamesWarning}`,
        confirmLabel: 'Объединить',
      });
      if (!ok) return;
      setBusy(true);
      setError('');
      try {
        const r = await (window.matrica.warehouse as any).partsDedupeMerge({ survivorId, mergedIds });
        if (!r?.ok) {
          setError(String(r?.error ?? 'не удалось объединить'));
          return;
        }
        setLastReport(r.report as MergeReport);
        await analyze();
      } finally {
        setBusy(false);
      }
    },
    [analyze, checked, confirm, groups, survivors],
  );

  const exactCount = useMemo(() => (groups ?? []).filter((g) => g.kind === 'exact').length, [groups]);
  const codeCollisionCount = useMemo(() => (groups ?? []).filter((g) => g.kind === 'code-collision').length, [groups]);
  const fuzzyCount = useMemo(() => (groups ?? []).filter((g) => g.kind === 'fuzzy').length, [groups]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Дубли номенклатуры</h2>
        <Button onClick={() => void analyze()} disabled={busy}>
          {busy ? 'Анализ…' : groups === null ? 'Найти дубли' : 'Повторить анализ'}
        </Button>
        {groups !== null && (
          <span style={{ color: '#64748b', fontSize: 13 }}>
            деталей в справочнике: {totalParts} · жёстких групп: {exactCount} · коллизий артикула: {codeCollisionCount} ·
            похожих групп: {fuzzyCount}
          </span>
        )}
      </div>

      <div style={{ color: '#64748b', fontSize: 13, maxWidth: 900 }}>
        Жёсткий дубль — одинаковые название и артикул (галочки уже проставлены). Коллизия артикула — один и тот же код у разных
        названий: это либо настоящий дубль (слить), либо ошибочно проставленный код (исправить код у одной из деталей) — решает
        оператор. «Похожие» — кандидаты по близости названия (опечатка, перестановка слов, лишнее слово) с совместимыми
        артикулами. Главная деталь (●) получает все остатки, движения, спецификации, строки актов и привязки к маркам
        поглощаемых.
      </div>

      {error && <div style={{ color: '#b91c1c' }}>{error}</div>}

      {lastReport && (
        <div style={{ background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 10, padding: 10, fontSize: 13 }}>
          <b>Слияние выполнено.</b> Поглощено: {lastReport.merged.length}. Перевешено:{' '}
          {lastReport.merged
            .map(
              (m) =>
                `остатки ${m.repointed.stockBalances}, движения ${m.repointed.stockMovements}, BOM ${m.repointed.bomLines}, документы ${m.repointed.docLines}, акты ${m.repointed.operations}`,
            )
            .join('; ')}
          {lastReport.fills.length > 0 && <div>Дозаполнено у главной: {lastReport.fills.join('; ')}</div>}
          {lastReport.conflicts.length > 0 && (
            <div style={{ color: '#92400e' }}>Конфликты (оставлены значения главной): {lastReport.conflicts.join('; ')}</div>
          )}
        </div>
      )}

      {groups !== null && groups.length === 0 && <div style={{ color: '#16a34a' }}>Дубликатов не найдено 🎉</div>}

      {(groups ?? []).map((g, idx) => {
        const sel = checked[idx] ?? {};
        const survivorId = survivors[idx] ?? '';
        const mergeCount = g.parts.filter((p) => sel[p.id] && p.id !== survivorId).length;
        const survivorChecked = Boolean(sel[survivorId]);
        const style = GROUP_STYLE[g.kind];
        return (
          <div
            key={idx}
            style={{
              border: `1px solid ${style.border}`,
              borderRadius: 12,
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: style.background,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13, color: style.color }}>{style.title}</div>
            <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: '#64748b', textAlign: 'left' }}>
                  <th style={{ padding: '4px 8px' }}>Слить</th>
                  <th style={{ padding: '4px 8px' }}>Главная</th>
                  <th style={{ padding: '4px 8px' }}>Название</th>
                  <th style={{ padding: '4px 8px' }}>Артикул</th>
                  <th style={{ padding: '4px 8px' }}>Использование</th>
                </tr>
              </thead>
              <tbody>
                {g.parts.map((p) => (
                  <tr key={p.id} style={{ borderTop: '1px solid #e2e8f0', opacity: p.isActive ? 1 : 0.6 }}>
                    <td style={{ padding: '4px 8px' }}>
                      <input
                        type="checkbox"
                        checked={Boolean(sel[p.id])}
                        disabled={!props.canEdit}
                        onChange={(e) =>
                          setChecked((prev) => ({ ...prev, [idx]: { ...(prev[idx] ?? {}), [p.id]: e.target.checked } }))
                        }
                      />
                    </td>
                    <td style={{ padding: '4px 8px' }}>
                      <input
                        type="radio"
                        name={`survivor-${idx}`}
                        checked={survivorId === p.id}
                        disabled={!props.canEdit}
                        onChange={() => setSurvivors((prev) => ({ ...prev, [idx]: p.id }))}
                      />
                    </td>
                    <td style={{ padding: '4px 8px', fontWeight: survivorId === p.id ? 600 : 400 }}>{p.name}</td>
                    <td style={{ padding: '4px 8px', fontFamily: 'monospace' }}>{p.code ?? '—'}</td>
                    <td style={{ padding: '4px 8px', color: '#64748b' }}>{usageLabel(p.usage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {props.canEdit && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Button onClick={() => void mergeGroup(idx)} disabled={busy || mergeCount === 0 || !survivorChecked}>
                  Объединить выбранные ({mergeCount} → 1)
                </Button>
                {!survivorChecked && <span style={{ color: '#94a3b8', fontSize: 12 }}>отметьте главную деталь галочкой «Слить», чтобы включить её в группу слияния</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
