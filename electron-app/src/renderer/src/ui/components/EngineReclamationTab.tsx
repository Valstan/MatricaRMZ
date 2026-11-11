import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { normalizeLookupCompact, validateEngineReclamationQueue } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { SectionCard } from './SectionCard.js';
import { SearchSelect } from './SearchSelect.js';
import { UnifiedDateInput } from './UnifiedDateInput.js';
import { AutoGrowTextarea } from './AutoGrowTextarea.js';
import { insertTextAtSelection } from '../utils/insertText.js';

/**
 * Вкладка «Рекламация» карточки двигателя — очередь заездов по рекламации.
 *
 * Владелец (10.11.2026): «рекламаций может быть несколько, и они должны иметь свою
 * очередность, то есть первая, вторая, третья, чтобы у нас там даты прихода двигателя
 * и отгрузки двигателя по рекламациям тоже не пересекались друг с другом… может
 * быть, даже сделать пополам, поделить это окно, то есть, вот и слева будет первая
 * рекламация, вторая, рекламация, третья, а справа это будет уже сама раскрываться».
 *
 * Слева — очередь (1-я, 2-я, 3-я …), справа — выбранная рекламация. Основной цикл
 * карточки — заезд №1, рекламация №1 — заезд №2: даты заездов не должны пересекаться,
 * и это проверяется гейтом (`validateEngineReclamationQueue`) ДО записи.
 *
 * Очередь живёт в отдельной строгой таблице (`erp_engine_reclamations`): запись идёт
 * серверной дверью REST, чтение — из реплики. Панель вкладок не размонтируется
 * (скрытие через `hidden`), поэтому очередь держится в состоянии компонента и
 * перечитывается при открытии вкладки.
 */
export type ReclamationDraft = {
  id: string | null;
  /** Номер в очереди: 1, 2, 3 … */
  queueNo: number;
  acceptedDate: string;
  defectDescription: string;
  actualDefect: string;
  defectNature: string;
  actNumber: string;
  actDate: string;
  shippedDate: string;
  comment: string;
};

function emptyDraft(queueNo: number): ReclamationDraft {
  return {
    id: null,
    queueNo,
    acceptedDate: '',
    defectDescription: '',
    actualDefect: '',
    defectNature: '',
    actNumber: '',
    actDate: '',
    shippedDate: '',
    comment: '',
  };
}

function toDraft(row: {
  id: string;
  queueNo: number;
  acceptedAt: number | null;
  shippedAt: number | null;
  customerReason: string | null;
  actualDefect: string | null;
  defectNature: string | null;
  actNumber: string | null;
  actDate: number | null;
  comment: string | null;
}): ReclamationDraft {
  const iso = (ms: number | null): string => {
    if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  return {
    id: row.id,
    queueNo: row.queueNo,
    acceptedDate: iso(row.acceptedAt),
    defectDescription: row.customerReason ?? '',
    actualDefect: row.actualDefect ?? '',
    defectNature: row.defectNature ?? '',
    actNumber: row.actNumber ?? '',
    actDate: iso(row.actDate),
    shippedDate: iso(row.shippedAt),
    comment: row.comment ?? '',
  };
}

function fromIsoDate(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const ts = new Date(Number(y), Number(mo) - 1, Number(d), 12, 0, 0, 0).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Ручка вкладки «Рекламация» для карточки двигателя.
 *
 * Очередь пишется своей кнопкой («Сохранить очередь»), и кнопки шапки карточки
 * («Сохранить» / «Сохранить и выйти») про неё не знали: оператор жал «Сохранить»
 * в шапке и думал, что рекламация сохранена, а она оставалась в форме. `flush`
 * даёт карточке возможность сбросить очередь в базу ДО сохранения карточки —
 * одна кнопка сохраняет всё.
 */
export type EngineReclamationTabHandle = {
  /** Сохранить несохранённую очередь. `false` — запись не удалась, карточку закрывать нельзя. */
  flush: () => Promise<boolean>;
};

export function EngineReclamationTab(props: {
  visible: boolean;
  canEdit: boolean;
  readOnlyNote: React.ReactNode;
  /** Двигатель — владелец очереди. */
  engineId: string;
  /** Даты основного цикла (заезд №1) — для гейта «заезды не пересекаются». */
  mainAcceptedDate?: string | null | undefined;
  mainShippedDate?: string | null | undefined;
  /** Патч EAV-меток карточки (флаг «рекламационный»). */
  onPatchFlag?: (flag: boolean) => void;
  /**
   * Зеркало последней (текущей) рекламации в EAV-атрибуты карточки: по ним читают
   * клиенты прежней версии и источник правды по датам на сервере.
   */
  onPatchMirror?: (mirror: Partial<ReclamationDraft>) => void;
  natureOptions: string[];
  onNotice: (text: string) => void;
  attachmentsSlot: React.ReactNode;
  /** Ручка вкладки для карточки двигателя (см. EngineReclamationTabHandle). */
  registerHandle?: (handle: EngineReclamationTabHandle | null) => void;
}) {
  const { canEdit } = props;
  const [queue, setQueue] = useState<ReclamationDraft[]>([]);
  const [selectedQueueNo, setSelectedQueueNo] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const descriptionRef = React.useRef<HTMLTextAreaElement | null>(null);
  const actualDefectRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [addingNature, setAddingNature] = useState(false);
  const [newNature, setNewNature] = useState('');
  /** Очередь правится, но не записана на сервер — карточка должна сбросить её перед своим сохранением. */
  const [dirty, setDirty] = useState(false);
  /** Очередь сохранена в этой сессии — её держим локально, реплику не перечитываем. */
  const [savedLocally, setSavedLocally] = useState(false);
  /**
   * Откуда взята очередь в форме: 'server' — сервер подтвердил (можно сохранять и пустую),
   * 'replica' — локальная копия (отстаёт; пустую сохранять нельзя, иначе сервер снесёт
   * рекламацию, которой оператор не видел).
   */
  const [queueSource, setQueueSource] = useState<'server' | 'replica' | null>(null);
  /**
   * Id строк, которые вкладка ВИДЕЛА (прочитала с сервера). По ним сервер понимает,
   * какие строки снять осознанно, а какие — просто не попали в устаревшую форму.
   * Не путать со строками в форме: снятая оператором строка из формы исчезает, но из
   * «виденных» остаётся — иначе сервер не поймёт, что её надо снять.
   */
  const [knownIds, setKnownIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!props.engineId) return;
    setLoading(true);
    try {
      const res = await window.matrica.engineReclamations.list(props.engineId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const rows = res.rows.map(toDraft);
      setQueue(rows);
      setDirty(false);
      setQueueSource(res.source ?? 'replica');
      setKnownIds(rows.map((r) => r.id).filter((id): id is string => Boolean(id)));
      setSelectedQueueNo((prev) => prev ?? (rows[0]?.queueNo ?? null));
    } finally {
      setLoading(false);
    }
  }, [props.engineId]);

  useEffect(() => {
    // Перечитываем реплику только если правок нет: иначе уход на другую вкладку
    // стирал бы несохранённую очередь (как и случилось — оператор жал «Сохранить
    // очередь», видел пустую форму и жал ещё раз).
    //
    // После УДАЧНОГО сохранения очередь тоже не перечитываем: реплика отстаёт от
    // сервера (pull ещё не пришёл), и перечитывание стирало бы только что сохранённое —
    // оператор видел бы пустую очередь и жал кнопку ещё раз (жалоба владельца
    // 11.11.2026, двигатель Е02АТ5382). Данные сохранённой очереди — ответ сервера,
    // он и есть правда; реплика догонит её позже сама.
    if (!props.visible) return;
    if (dirty || savedLocally) return;
    void load();
  }, [props.visible, load, dirty, savedLocally]);

  const selected = useMemo(() => queue.find((q) => q.queueNo === selectedQueueNo) ?? null, [queue, selectedQueueNo]);

  const patchSelected = (patch: Partial<ReclamationDraft>) => {
    if (selectedQueueNo == null) return;
    setDirty(true);
    setSavedLocally(false);
    setQueue((prev) => prev.map((q) => (q.queueNo === selectedQueueNo ? { ...q, ...patch } : q)));
  };

  const addReclamation = () => {
    const nextNo = queue.length === 0 ? 1 : Math.max(...queue.map((q) => q.queueNo)) + 1;
    setDirty(true);
    setSavedLocally(false);
    setQueue((prev) => [...prev, emptyDraft(nextNo)]);
    setSelectedQueueNo(nextNo);
  };

  const removeReclamation = (queueNo: number) => {
    setDirty(true);
    setSavedLocally(false);
    setQueue((prev) =>
      prev.filter((q) => q.queueNo !== queueNo).map((q, i) => (q.queueNo > queueNo ? { ...q, queueNo: i + 1 } : q)),
    );
    setSelectedQueueNo((prev) => (prev === queueNo ? null : prev));
  };

  /** Гейт дат — заезды не должны пересекаться (проверяется и до записи, и на сервере). */
  const gateError = useMemo(
    () =>
      validateEngineReclamationQueue({
        rows: queue.map((q) => ({
          queueNo: q.queueNo,
          acceptedAt: fromIsoDate(q.acceptedDate),
          shippedAt: fromIsoDate(q.shippedDate),
        })),
        mainArrivalDate: fromIsoDate(props.mainAcceptedDate ?? ''),
        mainShippingDate: fromIsoDate(props.mainShippedDate ?? ''),
      }),
    [queue, props.mainAcceptedDate, props.mainShippedDate],
  );

  const saveQueue = async (): Promise<boolean> => {
    if (!props.engineId) return false;
    // ПУСТАЯ ОЧЕРЕДЬ, НЕ ПОДТВЕРЖДЁННАЯ СЕРВЕРОМ, — НЕ СОХРАНЯЕТСЯ (жалоба владельца
    // 11.11.2026, Е02АТ5382). Дверь «заменяет очередь»: пустой список = «рекламаций нет» →
    // сервер смягко удаляет всё, что там было. Если очередь в форме пустая, потому что её
    // не удалось прочитать (нет связи, реплика отстала), такой «сброс» снёс бы рекламацию,
    // которой оператор просто не видел.
    if (queueSource === 'replica') {
      const msg = 'Очередь прочитана из локальной копии — она может отставать от сервера. Сохранять нельзя: сервер счёл бы снятые строки лишними. Дождитесь связи и обновите вкладку.';
      setError(msg);
      props.onNotice(msg);
      return false;
    }
    const gate = validateEngineReclamationQueue({
      rows: queue.map((q) => ({
        queueNo: q.queueNo,
        acceptedAt: fromIsoDate(q.acceptedDate),
        shippedAt: fromIsoDate(q.shippedDate),
      })),
      mainArrivalDate: fromIsoDate(props.mainAcceptedDate ?? ''),
      mainShippingDate: fromIsoDate(props.mainShippedDate ?? ''),
    });
    if (gate) {
      setError(gate);
      props.onNotice(gate);
      return false;
    }
    setBusy(true);
    setError('');
    try {
      const res = await window.matrica.engineReclamations.save({
        engineId: props.engineId,
        rows: queue.map((q) => ({
          id: q.id,
          queueNo: q.queueNo,
          acceptedAt: fromIsoDate(q.acceptedDate),
          shippedAt: fromIsoDate(q.shippedDate),
          customerReason: q.defectDescription || null,
          actualDefect: q.actualDefect || null,
          defectNature: q.defectNature || null,
          actNumber: q.actNumber || null,
          actDate: fromIsoDate(q.actDate),
          comment: q.comment || null,
        })),
        mainArrivalDate: fromIsoDate(props.mainAcceptedDate ?? ''),
        mainShippingDate: fromIsoDate(props.mainShippedDate ?? ''),
        // Очистка — только явная: пустой список без подтверждения сервер не сносит.
        clear: queue.length === 0 && queueSource === 'server',
        // Что вкладка видела: сервер снимет только эти строки.
        knownIds,
      });
      if (!res.ok) {
        setError(res.error);
        props.onNotice(res.error);
        return false;
      }
      if (res.cleared === false) {
        const msg = 'Очередь на сервере не очищена — сервер не принял подтверждение очистки. Рекламация на месте; обновите программу и повторите.';
        setError(msg);
        props.onNotice(msg);
        return false;
      }
      // Итоговую очередь берём ОТ СЕРВЕРА, а не перечитываем локальную реплику:
      // реплика отстаёт (pull ещё не пришёл), и перечитывание сразу после
      // сохранения показывало бы пустую очередь — оператор видел «не сохраняется»
      // и жал кнопку ещё раз, плодя новые строки вместо правки прежней
      // (жалоба владельца 11.11.2026, двигатель Е02АТ5382).
      const saved = (res.rows ?? []).map(toDraft);
      setQueue(saved);
      setDirty(false);
      setSavedLocally(true);
      setKnownIds(saved.map((r) => r.id).filter((id): id is string => Boolean(id)));
      setSelectedQueueNo((prev) => prev ?? (saved[0]?.queueNo ?? null));
      props.onPatchFlag?.(saved.length > 0);
      // Зеркало текущей рекламации — последняя в очереди: именно она «сейчас».
      const current = saved.length === 0 ? null : saved.reduce((a, b) => (b.queueNo > a.queueNo ? b : a));
      props.onPatchMirror?.(
        current
          ? {
              acceptedDate: current.acceptedDate,
              defectDescription: current.defectDescription,
              actualDefect: current.actualDefect,
              defectNature: current.defectNature,
              actNumber: current.actNumber,
              actDate: current.actDate,
              shippedDate: current.shippedDate,
              comment: current.comment,
            }
          : {
              acceptedDate: '',
              defectDescription: '',
              actualDefect: '',
              defectNature: '',
              actNumber: '',
              actDate: '',
              shippedDate: '',
              comment: '',
            },
      );
      props.onNotice('Очередь рекламаций сохранена.');
      // Приёмка по рекламации — этап истории ремонта. Если этап не завелся (нет права
      // или гейт отказал), оператор должен знать: в списке и отчётах этого этапа не будет.
      const stages = res.stages;
      if (stages && stages.errors.length > 0) {
        setError(stages.errors.join('; '));
        props.onNotice(`Очередь сохранена, но этап приёмки по рекламации не заведён: ${stages.errors.join('; ')}`);
      } else if (stages && (stages.created > 0 || stages.updated > 0)) {
        props.onNotice('Очередь рекламаций сохранена — приёмка по рекламации внесена в историю ремонта.');
      }
      return true;
    } finally {
      setBusy(false);
    }
  };

  // Ручка для карточки двигателя: кнопки «Сохранить» / «Сохранить и выйти» в шапке
  // про очередь не знали, и оператор жал «Сохранить» в шапке, думая, что рекламация
  // сохранена (жалоба владельца 11.11.2026). Теперь карточка сбрасывает очередь в
  // базу перед своим сохранением — одна кнопка сохраняет всё.
  //
  // Ссылки обновляем после каждого рендера, а ручку регистрируем один раз — её
  // содержимое всегда смотрит на актуальные `saveQueue` и `dirty` (как на вкладке
  // «Платежи»).
  const saveQueueRef = useRef<() => Promise<boolean>>(async () => true);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    saveQueueRef.current = saveQueue;
    dirtyRef.current = dirty;
  });
  const registerHandle = props.registerHandle;
  useEffect(() => {
    registerHandle?.({
      flush: async () => (dirtyRef.current ? saveQueueRef.current() : true),
    });
    return () => registerHandle?.(null);
  }, [registerHandle]);

  async function pasteInto(
    ref: React.MutableRefObject<HTMLTextAreaElement | null>,
    current: string,
    apply: (next: string) => void,
    source: 'clipboard' | 'file',
  ) {
    const el = ref.current;
    const selection = el ? { start: el.selectionStart, end: el.selectionEnd } : null;
    const r = source === 'clipboard' ? await window.matrica.files.clipboardText() : await window.matrica.files.pickText();
    if (!r.ok) {
      if (r.error !== 'cancelled') props.onNotice(r.error);
      return;
    }
    const { next, caret } = insertTextAtSelection(current, r.text, selection);
    apply(next);
    window.setTimeout(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(caret, caret);
    }, 0);
  }

  const pasteButtons = (
    ref: React.MutableRefObject<HTMLTextAreaElement | null>,
    current: string,
    apply: (next: string) => void,
    tag: string,
  ) =>
    canEdit ? (
      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        <Button
          variant="ghost"
          data-recl-action={`${tag}-clipboard`}
          title="Вставить в это поле текст, скопированный в буфер обмена"
          onClick={() => void pasteInto(ref, current, apply, 'clipboard')}
        >
          Вставить текст из буфера
        </Button>
        <Button
          variant="ghost"
          data-recl-action={`${tag}-file`}
          title="Взять текст из файла .txt или .docx"
          onClick={() => void pasteInto(ref, current, apply, 'file')}
        >
          Вставить текст из файла
        </Button>
      </div>
    ) : null;

  function commitNewNature() {
    const label = newNature.trim();
    if (!label) return;
    const key = normalizeLookupCompact(label);
    const existing = props.natureOptions.find((o) => normalizeLookupCompact(o) === key);
    if (existing) {
      props.onNotice(`Такой характер дефекта уже есть: ${existing}`);
      patchSelected({ defectNature: existing });
    } else {
      patchSelected({ defectNature: label });
    }
    setNewNature('');
    setAddingNature(false);
  }

  const row = (label: string, control: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 220px) 1fr', gap: 8, alignItems: 'center' }}>
      <div style={{ color: 'var(--subtle)' }}>{label}</div>
      {control}
    </div>
  );

  const blockRow = (label: string, control: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 220px) 1fr', gap: 8, alignItems: 'start' }}>
      <div style={{ color: 'var(--subtle)', paddingTop: 6 }}>{label}</div>
      {control}
    </div>
  );

  const dateInput = (value: string, set: (next: string) => void, title: string, tag: string) => (
    <UnifiedDateInput
      type="date"
      value={value}
      disabled={!canEdit}
      style={{ maxWidth: '22ch' }}
      title={title}
      data-recl-field={tag}
      onChange={(e) => set(String(e.target.value ?? ''))}
    />
  );

  if (loading && queue.length === 0) {
    return (
      <SectionCard style={{ padding: 16 }}>
        <div style={{ color: 'var(--subtle)', fontSize: 13 }}>Загружаем очередь рекламаций…</div>
      </SectionCard>
    );
  }

  return (
    <SectionCard style={{ padding: 16, background: 'rgba(37, 99, 235, 0.06)' }}>
      <div
        style={{
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'minmax(200px, 260px) minmax(0, 1fr)',
          alignItems: 'start',
        }}
      >
        {/* ЛЕВАЯ ЧАСТЬ — очередь рекламаций */}
        <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 13 }}>Рекламации</strong>
            <span style={{ flex: 1 }} />
            {canEdit ? (
              <Button variant="ghost" data-recl-action="add" onClick={addReclamation}>
                Добавить
              </Button>
            ) : null}
          </div>
          {queue.length === 0 ? <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Двигатель не принят по рекламации.</div> : null}
          {queue.map((q) => {
            const active = q.queueNo === selectedQueueNo;
            return (
              <div
                key={q.queueNo}
                style={{
                  display: 'grid',
                  gap: 4,
                  padding: '6px 8px',
                  borderRadius: 8,
                  border: `1px solid ${active ? 'var(--input-border-focus, #2563eb)' : 'var(--border)'}`,
                  background: active ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => setSelectedQueueNo(q.queueNo)}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      fontWeight: 600,
                      fontSize: 13,
                      padding: 0,
                      textAlign: 'left',
                      color: 'inherit',
                    }}
                  >
                    Рекламация №{q.queueNo}
                  </button>
                  <span style={{ flex: 1 }} />
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => removeReclamation(q.queueNo)}
                      title="Убрать рекламацию из очереди"
                      style={{ border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
                <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
                  {q.acceptedDate ? `приём ${q.acceptedDate}` : 'приём не задан'}
                  {q.shippedDate ? ` · отправка ${q.shippedDate}` : ''}
                </div>
              </div>
            );
          })}
          {canEdit ? (
            <Button onClick={() => void saveQueue()} disabled={busy}>
              Сохранить очередь
            </Button>
          ) : null}
          {error ? <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div> : null}
          {gateError && !error ? <div style={{ color: 'var(--danger)', fontSize: 12 }}>{gateError}</div> : null}
        </div>

        {/* ПРАВАЯ ЧАСТЬ — выбранная рекламация */}
        <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          {!selected ? (
            <div className="ui-muted" style={{ fontSize: 13 }}>
              {queue.length === 0
                ? 'Рекламаций нет. Основной цикл — заезд №1; рекламация №1 — заезд №2.'
                : 'Выберите рекламацию в очереди слева.'}
            </div>
          ) : (
            <>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Рекламация №{selected.queueNo}</div>
              {row(
                'Дата приёмки по рекламации',
                dateInput(
                  selected.acceptedDate,
                  (v) => patchSelected({ acceptedDate: v }),
                  'Когда двигатель принят по рекламации',
                  'accepted-date',
                ),
              )}

              {blockRow(
                'Описание дефекта изделия',
                <div>
                  {pasteButtons(
                    descriptionRef,
                    selected.defectDescription,
                    (v) => patchSelected({ defectDescription: v }),
                    'description',
                  )}
                  <AutoGrowTextarea
                    value={selected.defectDescription}
                    onChange={(v) => patchSelected({ defectDescription: v })}
                    visible={props.visible}
                    disabled={!canEdit}
                    placeholder="Что заявил заказчик и что видно на изделии"
                    inputRef={descriptionRef}
                    dataTag="description"
                  />
                </div>,
              )}

              {blockRow(
                'Фактически установленный дефект',
                <div>
                  {pasteButtons(
                    actualDefectRef,
                    selected.actualDefect,
                    (v) => patchSelected({ actualDefect: v }),
                    'actual-defect',
                  )}
                  <AutoGrowTextarea
                    value={selected.actualDefect}
                    onChange={(v) => patchSelected({ actualDefect: v })}
                    visible={props.visible}
                    disabled={!canEdit}
                    placeholder="Что установили при разборе"
                    inputRef={actualDefectRef}
                    dataTag="actual-defect"
                  />
                </div>,
              )}

              {row(
                'Установленный характер дефекта',
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 260, flex: '1 1 260px' }} data-recl-field="defect-nature">
                    <SearchSelect
                      value={selected.defectNature || null}
                      options={props.natureOptions.map((label) => ({ id: label, label }))}
                      disabled={!canEdit}
                      showAllWhenEmpty
                      placeholder="— не установлен —"
                      onChange={(next) => patchSelected({ defectNature: next ?? '' })}
                    />
                  </div>
                  {canEdit && !addingNature ? (
                    <Button
                      variant="ghost"
                      data-recl-action="add-nature"
                      title="Добавить в список свой характер дефекта"
                      onClick={() => setAddingNature(true)}
                    >
                      Добавить новый характер дефекта
                    </Button>
                  ) : null}
                  {canEdit && addingNature ? (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <Input
                        autoFocus
                        value={newNature}
                        placeholder="Название характера дефекта"
                        data-recl-field="new-nature"
                        style={{ maxWidth: '32ch' }}
                        onChange={(e) => setNewNature(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitNewNature();
                          if (e.key === 'Escape') {
                            setNewNature('');
                            setAddingNature(false);
                          }
                        }}
                      />
                      <Button data-recl-action="add-nature-commit" onClick={commitNewNature}>
                        Добавить
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setNewNature('');
                          setAddingNature(false);
                        }}
                      >
                        Отмена
                      </Button>
                    </div>
                  ) : null}
                </div>,
              )}

              {row(
                'Номер акта исследования',
                <Input
                  value={selected.actNumber}
                  disabled={!canEdit}
                  style={{ maxWidth: '32ch' }}
                  placeholder="Например, 14/26"
                  data-recl-field="act-number"
                  onChange={(e) => patchSelected({ actNumber: e.target.value })}
                />,
              )}

              {row(
                'Дата акта исследования',
                dateInput(selected.actDate, (v) => patchSelected({ actDate: v }), 'Дата акта исследования', 'act-date'),
              )}

              {row(
                'Дата отправки заказчику',
                dateInput(
                  selected.shippedDate,
                  (v) => patchSelected({ shippedDate: v }),
                  'Когда двигатель отправлен заказчику после рекламации',
                  'shipped-date',
                ),
              )}

              {blockRow(
                'Комментарий',
                <AutoGrowTextarea
                  value={selected.comment}
                  onChange={(v) => patchSelected({ comment: v })}
                  visible={props.visible}
                  disabled={!canEdit}
                  placeholder="Что было и чем всё закончилось"
                  minRows={4}
                  dataTag="comment"
                />,
              )}

              <div data-recl-field="attachments">{props.attachmentsSlot}</div>
            </>
          )}
          {!canEdit ? props.readOnlyNote : null}
        </div>
      </div>
    </SectionCard>
  );
}
