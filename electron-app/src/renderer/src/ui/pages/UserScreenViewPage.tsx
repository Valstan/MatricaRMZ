import React, { useEffect, useMemo, useState } from 'react';
import {
  MOCK_BLOCK_LABELS_RU,
  describeUiSpecForDeveloper,
  orderBlocksForReading,
  sanitizeUiSpec,
  type CustomReportSpecV1,
  type MockBlock,
  type UiScreenDetails,
  type UiSpecV2,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { theme } from '../theme.js';
import { MockupCanvas } from '../uiBuilder/MockupCanvas.js';

type RunOk = Extract<Awaited<ReturnType<typeof window.matrica.reports.customRun>>, { ok: true }>;
type LiveState = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ok'; report: RunOk };

function formatCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  return String(value);
}

/** Живой отчёт внутри блока эскиза: данные шаблона «Моих отчётов» в размерах блока. */
function LiveReportBody(props: { block: MockBlock; state: LiveState | undefined; onRefresh: () => void }) {
  const { block: b, state } = props;
  const title = b.label?.trim() || (state?.status === 'ok' ? state.report.title : 'Отчёт');
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        border: `1px solid ${theme.colors.border}`,
        borderRadius: 6,
        overflow: 'hidden',
        background: 'var(--panel, transparent)',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: `1px solid ${theme.colors.border}`, fontWeight: 600 }}>
        <span>📊</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {state?.status === 'ok' ? (
          <span style={{ color: theme.colors.muted, fontWeight: 400 }}>строк: {state.report.rowCount}</span>
        ) : null}
        <span
          onClick={(e) => {
            e.stopPropagation();
            props.onRefresh();
          }}
          title="Обновить данные"
          style={{ cursor: 'pointer' }}
        >
          ⟳
        </span>
      </div>
      {state == null || state.status === 'loading' ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.colors.muted }}>Загрузка…</div>
      ) : state.status === 'error' ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.colors.muted, padding: 8, textAlign: 'center' }}>
          {state.error}
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                {state.report.columns.map((c) => (
                  <th
                    key={c.key}
                    style={{
                      position: 'sticky',
                      top: 0,
                      background: 'var(--panel, #fff)',
                      textAlign: c.align === 'right' ? 'right' : 'left',
                      padding: '3px 6px',
                      borderBottom: `1px solid ${theme.colors.border}`,
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.report.rows.map((row, i) => (
                <tr key={i}>
                  {state.report.columns.map((c) => (
                    <td
                      key={c.key}
                      style={{
                        padding: '3px 6px',
                        borderBottom: `1px solid ${theme.colors.border}22`,
                        textAlign: c.align === 'right' ? 'right' : 'left',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {formatCell(row[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
              {state.report.totals ? (
                <tr>
                  {state.report.columns.map((c, i) => (
                    <td key={c.key} style={{ padding: '3px 6px', fontWeight: 700, borderTop: `1px solid ${theme.colors.border}`, textAlign: c.align === 'right' ? 'right' : 'left' }}>
                      {state.report.totals?.[c.key] != null
                        ? String(state.report.totals[c.key])
                        : i === 0
                          ? 'Итого'
                          : ''}
                    </td>
                  ))}
                </tr>
              ) : null}
            </tbody>
          </table>
          {state.report.rows.length === 0 ? (
            <div style={{ padding: 10, color: theme.colors.muted }}>Нет данных</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Просмотр экрана оператора: read-only холст + живые виджеты (блоки «Живой
 * отчёт» наполняются данными шаблона «Моих отчётов», кнопки с назначенной
 * вкладкой реально переходят) + нумерованные сноски и экспорт ТЗ.
 */
export function UserScreenViewPage(props: {
  screenId: string;
  onEdit: (id: string) => void;
  /** Переход по кнопке с targetTab; App валидирует id по доступным вкладкам. */
  onNavigateTab?: (tabId: string) => void;
}) {
  const [screen, setScreen] = useState<UiScreenDetails | null>(null);
  const [spec, setSpec] = useState<UiSpecV2 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, LiveState>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await window.matrica.uiScreens.get(props.screenId);
      if (!alive) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setScreen(res.screen);
      const parsed = sanitizeUiSpec(res.screen.specJson);
      setSpec(parsed);
      // Дашборд с живыми виджетами смотрят как рабочий экран — сноски по умолчанию прячем.
      const liveSpec = parsed?.blocks.some((b) => (b.kind === 'report' && b.reportTemplateId) || (b.kind === 'button' && b.targetTab)) ?? false;
      setShowAnnotations(!liveSpec);
      setError(null);
    })();
    return () => {
      alive = false;
    };
  }, [props.screenId]);

  const reportBlocks = useMemo(
    () => (spec ? spec.blocks.filter((b) => b.kind === 'report' && b.reportTemplateId) : []),
    [spec],
  );
  const hasLive = reportBlocks.length > 0 || (spec?.blocks.some((b) => b.kind === 'button' && b.targetTab) ?? false);

  async function runReportBlock(block: MockBlock, templateSpecById: Map<string, CustomReportSpecV1>) {
    const tplSpec = block.reportTemplateId ? templateSpecById.get(block.reportTemplateId) : undefined;
    if (!tplSpec) {
      setLive((prev) => ({ ...prev, [block.id]: { status: 'error', error: 'Шаблон отчёта не найден (удалён или принадлежит другому пользователю)' } }));
      return;
    }
    setLive((prev) => ({ ...prev, [block.id]: { status: 'loading' } }));
    try {
      const res = await window.matrica.reports.customRun({ spec: tplSpec });
      setLive((prev) => ({
        ...prev,
        [block.id]: res.ok ? { status: 'ok', report: res } : { status: 'error', error: res.error },
      }));
    } catch {
      setLive((prev) => ({ ...prev, [block.id]: { status: 'error', error: 'Не удалось построить отчёт' } }));
    }
  }

  async function loadTemplatesMap(): Promise<Map<string, CustomReportSpecV1>> {
    try {
      const status = await window.matrica.auth.status();
      const uid = String(status?.user?.id ?? '');
      const tpl = await window.matrica.reports.customTemplatesList({ userId: uid });
      if (!tpl.ok) return new Map();
      return new Map(tpl.templates.map((t) => [t.id, t.spec]));
    } catch {
      return new Map();
    }
  }

  useEffect(() => {
    if (reportBlocks.length === 0) return;
    let alive = true;
    (async () => {
      const map = await loadTemplatesMap();
      if (!alive) return;
      for (const b of reportBlocks) void runReportBlock(b, map);
    })();
    return () => {
      alive = false;
    };
  }, [reportBlocks]);

  const annotated = useMemo(() => {
    if (!spec) return [];
    return orderBlocksForReading(spec.blocks)
      .map((b, i) => ({ block: b, num: i + 1 }))
      .filter(({ block }) => block.note?.trim() || block.label?.trim());
  }, [spec]);

  async function copyDeveloperSpec() {
    if (!spec) return;
    try {
      await navigator.clipboard.writeText(describeUiSpecForDeveloper(spec, screen?.name));
      setToast('Описание для разработчика скопировано в буфер');
    } catch {
      setToast('Не удалось скопировать в буфер');
    }
    window.setTimeout(() => setToast(null), 3500);
  }

  function renderLiveBlock(b: MockBlock): React.ReactNode | null {
    if (b.kind === 'report' && b.reportTemplateId) {
      return (
        <LiveReportBody
          block={b}
          state={live[b.id]}
          onRefresh={() => {
            void loadTemplatesMap().then((map) => runReportBlock(b, map));
          }}
        />
      );
    }
    if (b.kind === 'button' && b.targetTab && props.onNavigateTab) {
      return (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `1.5px solid ${theme.colors.border}`,
            borderRadius: 8,
            background: 'var(--panel, transparent)',
            fontSize: 13,
            fontWeight: 600,
            overflow: 'hidden',
          }}
        >
          {b.label?.trim() || 'Перейти'} →
        </div>
      );
    }
    return null;
  }

  if (error) return <div style={{ padding: 16, fontSize: 13, color: theme.colors.muted }}>{error}</div>;
  if (!screen || !spec) return <div style={{ padding: 16, fontSize: 13, color: theme.colors.muted }}>Загрузка…</div>;

  return (
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 18, fontWeight: 700, flex: 1 }}>{screen.name}</div>
        <span style={{ fontSize: 12, color: theme.colors.muted }}>
          {hasLive
            ? 'Живые элементы (отчёты и кнопки-переходы) работают, остальное — эскиз'
            : 'Эскиз — элементы не действуют, это набросок будущего модуля'}
        </span>
        <Button size="sm" variant={showAnnotations ? 'primary' : 'ghost'} onClick={() => setShowAnnotations((v) => !v)}>
          № Сноски
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyDeveloperSpec()}>
          📋 Описание для разработчика
        </Button>
        {screen.canEdit ? (
          <Button size="sm" variant="ghost" onClick={() => props.onEdit(screen.id)}>
            Редактировать
          </Button>
        ) : null}
        {toast ? <span style={{ fontSize: 13, color: theme.colors.muted }}>{toast}</span> : null}
      </div>
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, minWidth: 0 }}>
          <MockupCanvas
            spec={spec}
            mode="view"
            showAnnotations={showAnnotations}
            renderLiveBlock={renderLiveBlock}
            {...(props.onNavigateTab
              ? { onActivateBlock: (b: MockBlock) => (b.targetTab ? props.onNavigateTab?.(b.targetTab) : undefined) }
              : {})}
          />
        </div>
        {showAnnotations && annotated.length > 0 ? (
          <div style={{ flex: '0 0 300px', overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Сноски</div>
            {annotated.map(({ block: b, num }) => (
              <div key={b.id} style={{ fontSize: 12, borderLeft: `2px solid ${theme.colors.border}`, paddingLeft: 8 }}>
                <div style={{ fontWeight: 600 }}>
                  {num}. {MOCK_BLOCK_LABELS_RU[b.kind]}
                  {b.label?.trim() ? ` «${b.label.trim()}»` : ''}
                </div>
                {b.note?.trim() ? <div style={{ color: theme.colors.muted, whiteSpace: 'pre-wrap' }}>{b.note.trim()}</div> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default UserScreenViewPage;
