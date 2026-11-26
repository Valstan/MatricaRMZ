import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ENGINE_CARD_TRANSFER_TARGETS,
  buildEngineCardTransferPreview,
  compareFindingsWithCard,
  engineCardMissingCharacteristics,
  groupFolderImagesByMatch,
  parseTransferDate,
  suggestTransferTargetCode,
  type EngineCardTransferTarget,
  type FileSearchComparisonRow,
  type FileSearchComparisonState,
  type FileSearchFinding,
  type FileSearchFolderResult,
  type FileSearchFolderSource,
  type FileSearchMatch,
  type FileSearchResult,
  type FileSearchSource,
  type FileSearchWordMatch,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SectionCard } from '../components/SectionCard.js';

type EngineLookup = {
  id: string;
  engineNumber: string;
  internalNumberFull: string;
  rmzCode: string;
  matchedBy: 'engine_number' | 'internal_number';
} | null;

type Pending = { value: string; label: string };

const KIND_RU: Record<FileSearchSource['kind'], string> = {
  excel: 'Excel',
  word: 'Word',
  text: 'Текст',
};

/** Ссылка в карточке лежит id — узнаём по виду uuid. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Пометка у находки: что с чем сошлось. */
const STATE_BADGE: Record<FileSearchComparisonState, { text: string; color: string }> = {
  same: { text: 'совпадает с карточкой', color: '#15803d' },
  different: { text: 'в карточке другое значение', color: '#b45309' },
  card_empty: { text: 'в карточке пусто — есть что перенести', color: '#15803d' },
  no_match: { text: 'в карточке нет такого пункта', color: '#64748b' },
  card_only: { text: 'только в карточке', color: '#64748b' },
};

/** Пометка у пункта карточки, когда его видно в найденном. */
const CARD_BADGE: Record<FileSearchComparisonState, { text: string; color: string } | null> = {
  same: { text: 'есть в файлах', color: '#15803d' },
  different: { text: 'расходится с файлами', color: '#b45309' },
  card_empty: { text: 'в файлах другое', color: '#15803d' },
  no_match: null,
  card_only: { text: 'только в карточке', color: '#64748b' },
};

function cardValueText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  const text = String(value).trim();
  return text ? text : null;
}

function formatMs(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Значение для показа: даты — датой, ссылки — названием из справочника.
 *
 * Без расшифровки в карточке видно «Контракт ed135695-…» — оператору это
 * ничего не говорит, и сверка «файл ↔ карточка» невозможна: в файле лежит
 * «303», а в карточке uuid.
 */
function displayValue(value: unknown, labels: Record<string, string>): string | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 1_000_000_000_000) return formatMs(value);
  const text = cardValueText(value);
  if (!text) return null;
  const label = labels[text];
  return label ?? text;
}

function matchKey(match: FileSearchMatch): string {
  return match.kind === 'excel'
    ? `${match.sourceId}:x:${match.sheetName}:${match.rowNumber}`
    : `${match.sourceId}:p:${match.paragraphIndex}`;
}

/** Находка из строки листа: подпись столбца и значение. */
type FindingCell = {
  index: number;
  cellKey: string;
  matchKey: string;
  label: string;
  value: string;
};

/**
 * Модуль «Поиск по файлам» (промт КАРМАНА #32).
 *
 * Три блока сверху вниз: файлы-источники → строка поиска → результаты.
 * Результаты — две колонки: слева что нашлось в файлах, справа карточка
 * двигателя из базы (по ТОЧНОМУ совпадению номера), сверка найденного с
 * карточкой и перенос найденного в её поля.
 *
 * Находки показываются не таблицей, а списком «подпись — значение»: в таблице
 * столбцы сжимались, и значения выходили по одному символу в строке.
 *
 * Файлы читает главный процесс: в renderer нет ни `exceljs`, ни `jszip`, ни
 * доступа к диску — только результаты поиска.
 */
export function FileSearchPage(props: { canEdit?: boolean }) {
  const canEdit = props.canEdit ?? true;
  const [sources, setSources] = useState<FileSearchSource[]>([]);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<FileSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  /**
   * Режим поиска: по содержимому файлов (было) или по названию в папках (стало).
   *
   * Два режима — две разные задачи оператора: найти сведения В документе или
   * найти ПАПКУ с фотографиями двигателя по номеру в её названии. Переключатель
   * рядом со строкой поиска, а не отдельный раздел — иначе оператору пришлось бы
   * гадать, в каком поле что набирать.
   */
  const [mode, setMode] = useState<'content' | 'folders'>('content');
  const [folders, setFolders] = useState<FileSearchFolderSource[]>([]);
  const [folderResult, setFolderResult] = useState<FileSearchFolderResult | null>(null);
  /** Отмеченные галочками картинки — по id, который выдал главный процесс. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** Крупные превью картинок: id → data-URL. */
  const [previews, setPreviews] = useState<Record<string, string>>({});
  /** Развёрнутые находки: по умолчанию открыта первая — сразу видно содержимое. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /**
   * Есть ли на машине системный мастер печати фотографий (промт #102).
   *
   * Renderer про ОС не знает — спрашиваем у главного процесса, и кнопка
   * прячется сама, если мастера нет.
   */
  const [osPrintWizard, setOsPrintWizard] = useState(false);

  const [lookup, setLookup] = useState<{ engine: EngineLookup; note: string | null } | null>(null);
  const [card, setCard] = useState<Record<string, unknown> | null>(null);
  const [defs, setDefs] = useState<{ code: string; name: string }[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [targetCode, setTargetCode] = useState<string>(ENGINE_CARD_TRANSFER_TARGETS[0]?.code ?? '');
  const [extraLines, setExtraLines] = useState<Record<string, string[]>>({});
  const [showAllCardOnly, setShowAllCardOnly] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await window.matrica.fileSearch.sources.get();
      if (res.ok) setSources(res.sources);
      const foldersRes = await window.matrica.fileSearch.folders.get();
      if (foldersRes.ok) setFolders(foldersRes.folders);
      const caps = await window.matrica.fileSearch.printCapabilities().catch(() => null);
      if (caps?.ok) setOsPrintWizard(caps.osPrintWizard);
    })();
  }, []);

  const persistSources = useCallback(async (next: FileSearchSource[]) => {
    setSources(next);
    const res = await window.matrica.fileSearch.sources.set({ sources: next });
    if (!res.ok) setStatus(`Не удалось запомнить список файлов: ${res.error}`);
  }, []);

  const addFiles = useCallback(async () => {
    const picked = await window.matrica.fileSearch.pick();
    if (!picked.ok) return;
    const merged = new Map(sources.map((s) => [s.id, s]));
    for (const source of picked.sources) merged.set(source.id, source);
    await persistSources([...merged.values()]);
    if (picked.skipped.length > 0) {
      setStatus(`Не взяты файлы: ${picked.skipped.map((s) => s.split(':')[0]).join(', ')} — формат не поддерживается.`);
    } else {
      setStatus('');
    }
  }, [persistSources, sources]);

  const reselect = useCallback(
    async (sourceId: string) => {
      await persistSources(sources.filter((s) => s.id !== sourceId));
      await addFiles();
    },
    [addFiles, persistSources, sources],
  );

  // ── Папки с фотографиями (промт КАРМАНА #88) ─────────────────────────────

  const persistFolders = useCallback(async (next: FileSearchFolderSource[]) => {
    setFolders(next);
    const res = await window.matrica.fileSearch.folders.set({ folders: next });
    if (!res.ok) setStatus(`Не удалось запомнить список папок: ${res.error}`);
  }, []);

  const addFolders = useCallback(async () => {
    const pickedRes = await window.matrica.fileSearch.pickFolder();
    if (!pickedRes.ok) return;
    const merged = new Map(folders.map((f) => [f.id, f]));
    for (const folder of pickedRes.folders) merged.set(folder.id, folder);
    await persistFolders([...merged.values()]);
    if (pickedRes.skipped.length > 0) {
      setStatus(`Не взяты папки: ${pickedRes.skipped.map((s) => s.split(':')[0]).join(', ')} — это не папка.`);
    } else {
      setStatus('');
    }
  }, [folders, persistFolders]);

  /**
   * Поиск по названию в папках.
   *
   * Сброс отметок и превью — старые id относятся к прошлому поиску, печатать их
   * уже нельзя (главный процесс их не выдавал).
   */
  const runFolderSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setStatus('Введите, что ищем — например номер двигателя.');
      return;
    }
    if (folders.length === 0) {
      setStatus('Сначала добавьте папки с фотографиями.');
      return;
    }
    setBusy(true);
    try {
      const res = await window.matrica.fileSearch.searchFolders({ query: q });
      if (!res.ok) {
        setStatus(`Ошибка поиска: ${res.error}`);
        return;
      }
      setFolderResult(res.result);
      setPicked(new Set());
      setPreviews({});
      // Первая находка открыта сразу: оператор сразу видит, что в папке.
      setExpanded(new Set(res.result.matches.slice(0, 1).map((m) => m.key)));
      setStatus('');
    } finally {
      setBusy(false);
    }
  }, [folders, query]);

  /**
   * Крупные превью подгружаем порциями, по мере разворачивания находки: фото
   * двигателя — тяжёлые файлы, грузить все сразу оператору незачем.
   */
  const imagesByMatch = useMemo(
    () => groupFolderImagesByMatch(folderResult?.images ?? []),
    [folderResult],
  );

  useEffect(() => {
    if (!folderResult) return;
    let alive = true;
    const wanted = folderResult.images
      .filter((image) => expanded.has(image.matchKey) && !(image.id in previews))
      .slice(0, 24);
    if (wanted.length === 0) return;
    void (async () => {
      for (const image of wanted) {
        if (!alive) return;
        const res = await window.matrica.fileSearch.imagePreview({ id: image.id }).catch(() => null);
        if (!alive) return;
        if (res?.ok) setPreviews((prev) => ({ ...prev, [image.id]: res.dataUrl }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [expanded, folderResult, previews]);

  const togglePicked = useCallback((imageId: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(imageId)) next.delete(imageId);
      else next.add(imageId);
      return next;
    });
  }, []);

  const printPicked = useCallback(async () => {
    if (picked.size === 0) {
      setStatus('Отметьте галочками картинки, которые нужно напечатать.');
      return;
    }
    setBusy(true);
    try {
      const res = await window.matrica.fileSearch.printImages({ ids: [...picked] });
      if (!res.ok) {
        setStatus(`Не отправилось на печать: ${res.error}`);
        return;
      }
      setStatus(`Отправлено на печать: ${picked.size}.`);
    } finally {
      setBusy(false);
    }
  }, [picked]);

  /**
   * Печать через СИСТЕМНЫЙ мастер печати фотографий (промт КАРМАНА #102) —
   * то, что владелец назвал «Microsoft Picture Manager»: в системном окне
   * оператор правит размер и раскладку и сам жмёт «Печать».
   *
   * Один файл — одно системное окно, поэтому картинок лучше отбирать немного.
   */
  const printPickedViaOs = useCallback(async () => {
    if (picked.size === 0) {
      setStatus('Отметьте галочками картинки, которые нужно напечатать.');
      return;
    }
    setBusy(true);
    try {
      const res = await window.matrica.fileSearch.printImages({ ids: [...picked], mode: 'os' });
      if (!res.ok) {
        setStatus(`${res.error}`);
        return;
      }
      setStatus(
        res.failed
          ? `Открыто окон мастера печати: ${res.opened}. Не открылось: ${res.failed}.`
          : `Открыто окон мастера печати: ${res.opened}. Правите размер и печатаете в них.`,
      );
    } finally {
      setBusy(false);
    }
  }, [picked]);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const loadEngine = useCallback(async (q: string) => {
    const found = await window.matrica.engines.findExactByNumber({ query: q });
    if (!found.ok) {
      setLookup({ engine: null, note: found.error });
      setCard(null);
      return;
    }
    setLookup({ engine: found.engine, note: found.note });
    if (!found.engine) {
      setCard(null);
      setDraft({});
      return;
    }
    const details = await window.matrica.engines.get(found.engine.id);
    const attrs = details.attributes ?? {};
    setCard(attrs);
    setDraft(
      Object.fromEntries(
        ENGINE_CARD_TRANSFER_TARGETS.map((target) => [target.code, cardValueText(attrs[target.code]) ?? '']),
      ),
    );
    const characteristics = await window.matrica.engines.characteristics();
    if (characteristics.ok) setDefs(characteristics.defs);
    // Ссылки карточки (id справочников) превращаем в названия — иначе оператор
    // видит uuid вместо номера договора и не может сверить карточку с файлом.
    const ids = Object.values(attrs)
      .filter((value): value is string => typeof value === 'string' && UUID_RE.test(value.trim()))
      .map((value) => value.trim());
    if (ids.length === 0) {
      setLabels({});
      return;
    }
    const resolved = await window.matrica.fileSearch.resolveLabels({ ids }).catch(() => null);
    setLabels(resolved?.ok ? resolved.labels : {});
  }, []);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setStatus('Введите, что ищем — например номер двигателя.');
      return;
    }
    if (sources.length === 0) {
      setStatus('Сначала добавьте файлы, в которых ищем.');
      return;
    }
    setBusy(true);
    try {
      const res = await window.matrica.fileSearch.search({ sources, query: q });
      if (!res.ok) {
        setStatus(`Ошибка поиска: ${res.error}`);
        return;
      }
      setResult(res.result);
      setStatus('');
      await loadEngine(q);
    } finally {
      setBusy(false);
    }
  }, [loadEngine, query, sources]);

  const target = useMemo<EngineCardTransferTarget>(
    () => ENGINE_CARD_TRANSFER_TARGETS.find((t) => t.code === targetCode) ?? ENGINE_CARD_TRANSFER_TARGETS[0]!,
    [targetCode],
  );

  const preview = useMemo(() => {
    if (!pending || !card) return null;
    return buildEngineCardTransferPreview({
      card,
      target,
      candidateValue: pending.value,
      candidateLabel: pending.label,
    });
  }, [card, pending, target]);

  const missing = useMemo(() => {
    if (!card) return [];
    return engineCardMissingCharacteristics({
      card,
      known: defs.map((d) => ({ code: d.code, label: d.name })),
    });
  }, [card, defs]);

  const filled = useMemo(() => {
    if (!card) return [];
    return defs
      .map((d) => ({ code: d.code, label: d.name, value: displayValue(card[d.code], labels) }))
      .filter((row) => row.value != null);
  }, [card, defs, labels]);

  /** Находки из строк листов: подпись столбца и значение. */
  const findingCells = useMemo<FindingCell[]>(() => {
    const cells: FindingCell[] = [];
    let index = 0;
    for (const match of result?.matches ?? []) {
      if (match.kind !== 'excel') continue;
      const key = matchKey(match);
      match.values.forEach((value, columnIndex) => {
        const text = String(value ?? '').trim();
        if (!text) return;
        cells.push({
          index,
          cellKey: `${key}:${columnIndex}`,
          matchKey: key,
          label: match.headers[columnIndex] || `Столбец ${columnIndex + 1}`,
          value: text,
        });
        index += 1;
      });
    }
    return cells;
  }, [result]);

  const cellsByMatch = useMemo(() => {
    const map = new Map<string, FindingCell[]>();
    for (const cell of findingCells) {
      const list = map.get(cell.matchKey) ?? [];
      list.push(cell);
      map.set(cell.matchKey, list);
    }
    return map;
  }, [findingCells]);

  const findings = useMemo<FileSearchFinding[]>(
    () => findingCells.map((cell) => ({ label: cell.label, value: cell.value })),
    [findingCells],
  );

  /**
   * Все поля карточки, включая пустые: пустое поле — это «есть что перенести».
   * В списке «только в карточке» пустые не показываются (это делает сверка).
   */
  const cardFields = useMemo(
    () => defs.map((d) => ({ code: d.code, label: d.name, value: displayValue(card?.[d.code], labels) })),
    [card, defs, labels],
  );

  const comparison = useMemo(
    () => compareFindingsWithCard({ findings, cardFields }),
    [cardFields, findings],
  );

  const comparisonByFinding = useMemo(() => {
    const map = new Map<string, FileSearchComparisonRow>();
    for (const row of comparison) {
      if (row.key.startsWith('f')) map.set(row.key, row);
    }
    return map;
  }, [comparison]);

  const comparisonByCardCode = useMemo(() => {
    const map = new Map<string, FileSearchComparisonRow>();
    for (const row of comparison) {
      if (row.cardCode) map.set(row.cardCode, row);
    }
    return map;
  }, [comparison]);

  const groups = useMemo(() => {
    const out: Record<FileSearchComparisonState, FileSearchComparisonRow[]> = {
      same: [],
      different: [],
      card_empty: [],
      no_match: [],
      card_only: [],
    };
    for (const row of comparison) out[row.state].push(row);
    return out;
  }, [comparison]);

  const transferableCodes = useMemo(() => new Set(ENGINE_CARD_TRANSFER_TARGETS.map((t) => t.code)), []);

  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('Значение скопировано в буфер обмена.');
    } catch {
      setStatus('Не удалось скопировать значение.');
    }
  }

  function chooseTransfer(value: string, label: string) {
    const suggested = suggestTransferTargetCode(label);
    const found = ENGINE_CARD_TRANSFER_TARGETS.find((t) => t.code === suggested);
    setPending({ value, label });
    setTargetCode(found?.code ?? targetCode);
  }

  function applyAutoTransfer() {
    if (!preview?.compatible) return;
    setDraft((prev) => ({ ...prev, [preview.target.code]: preview.candidateValue }));
    setStatus(`Значение подставлено в поле «${preview.target.label}». Запишите карточку кнопкой ниже.`);
  }

  function applyManualTransfer() {
    if (!pending) return;
    setDraft((prev) => ({ ...prev, [target.code]: pending.value }));
    setStatus(`Значение вставлено в поле «${target.label}» как есть — проверьте формат и запишите карточку.`);
  }

  async function saveCard() {
    if (!lookup?.engine || !card) return;
    const fields: Record<string, unknown> = {};
    for (const field of ENGINE_CARD_TRANSFER_TARGETS) {
      const raw = String(draft[field.code] ?? '').trim();
      if (!raw) continue;
      if (cardValueText(card[field.code]) === raw) continue;
      if (field.kind === 'date') {
        const ts = parseTransferDate(raw);
        if (ts == null) {
          setStatus(`«${field.label}»: «${raw}» — это не дата. Формат: ДД.ММ.ГГГГ.`);
          return;
        }
        fields[field.code] = ts;
      } else if (field.kind === 'number') {
        const n = Number(raw.replace(',', '.'));
        if (!Number.isFinite(n)) {
          setStatus(`«${field.label}»: «${raw}» — это не число.`);
          return;
        }
        fields[field.code] = n;
      } else {
        fields[field.code] = raw;
      }
    }
    if (Object.keys(fields).length === 0) {
      setStatus('Менять нечего — в полях те же значения, что и в карточке.');
      return;
    }
    const res = await window.matrica.engines.card.save({ id: lookup.engine.id, fields });
    if (!res.ok) {
      setStatus(`Не записалось: ${res.error ?? 'неизвестная причина'}`);
      return;
    }
    setStatus('Записано в карточку двигателя.');
    await loadEngine(query.trim());
  }

  async function showBelow(match: FileSearchWordMatch) {
    const source = sources.find((s) => s.id === match.sourceId);
    if (!source) return;
    const res = await window.matrica.fileSearch.context({
      source,
      paragraphIndex: match.paragraphIndex,
      count: 10,
    });
    if (!res.ok) {
      setStatus(`Не удалось показать строки ниже: ${res.error}`);
      return;
    }
    setExtraLines((prev) => ({ ...prev, [matchKey(match)]: res.paragraphs }));
  }

  const renderFindingRow = (cell: FindingCell) => {
    const cmp = comparisonByFinding.get(`f${cell.index}`);
    const badge = cmp ? STATE_BADGE[cmp.state] : null;
    return (
      <div
        key={cell.cellKey}
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
          padding: '6px 0',
          borderTop: '1px solid var(--input-border)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ width: 180, flexShrink: 0, color: 'var(--muted)', fontSize: 12, wordBreak: 'break-word' }}>
          {cell.label}
        </div>
        <div style={{ flex: 1, minWidth: 140, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{cell.value}</div>
        {badge ? (
          <span style={{ fontSize: 11, color: badge.color, whiteSpace: 'nowrap' }}>{badge.text}</span>
        ) : null}
        <div style={{ display: 'flex', gap: 4, whiteSpace: 'nowrap' }}>
          <Button size="sm" variant="outline" onClick={() => void copyValue(cell.value)}>
            Копировать
          </Button>
          <Button size="sm" variant="outline" onClick={() => chooseTransfer(cell.value, cell.label)}>
            В карточку
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SectionCard title="Файлы для поиска">
        <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
          Файлы читаются только на чтение — изменить их из модуля нельзя. Перед каждым поиском файлы перечитываются,
          поэтому ищется свежая версия. Пути запоминаются на этом компьютере.
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={() => void addFiles()} disabled={busy}>
            Добавить файлы
          </Button>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            {sources.length === 0 ? 'Файлы не выбраны' : `Файлов: ${sources.length}`}
          </span>
        </div>
        {sources.length > 0 ? (
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Файл</th>
                <th>Путь</th>
                <th>Тип</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td>{source.name}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 12, wordBreak: 'break-all' }}>{source.path}</td>
                  <td>{KIND_RU[source.kind]}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Button size="sm" variant="outline" onClick={() => void reselect(source.id)}>
                      Перевыбрать
                    </Button>{' '}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void persistSources(sources.filter((s) => s.id !== source.id))}
                    >
                      Убрать
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </SectionCard>

      <SectionCard title="Папки с фотографиями">
        <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
          Папки читаются только на чтение — изменить их из модуля нельзя. Поиск идёт по названию: вводите номер
          двигателя — найдём папку, в названии которой он есть, и покажем её фотографии. Пути запоминаются на этом
          компьютере.
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={() => void addFolders()} disabled={busy}>
            Добавить папки
          </Button>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            {folders.length === 0 ? 'Папки не выбраны' : `Папок: ${folders.length}`}
          </span>
        </div>
        {folders.length > 0 ? (
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Папка</th>
                <th>Путь</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {folders.map((folder) => (
                <tr key={folder.id}>
                  <td>{folder.name}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 12, wordBreak: 'break-all' }}>{folder.path}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void persistFolders(folders.filter((f) => f.id !== folder.id))}
                    >
                      Убрать
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </SectionCard>

      <SectionCard title="Что ищем">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>Ищем:</span>
          <Button
            size="sm"
            variant={mode === 'content' ? 'primary' : 'outline'}
            onClick={() => setMode('content')}
          >
            по содержимому файлов
          </Button>
          <Button
            size="sm"
            variant={mode === 'folders' ? 'primary' : 'outline'}
            onClick={() => setMode('folders')}
          >
            по названию в папках
          </Button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void (mode === 'folders' ? runFolderSearch() : runSearch());
            }}
            placeholder={mode === 'folders' ? 'Например: Э06АТ0889' : 'Например: 41/26'}
            style={{ flex: 1, minWidth: 220 }}
          />
          <Button
            variant="primary"
            onClick={() => void (mode === 'folders' ? runFolderSearch() : runSearch())}
            disabled={busy}
          >
            Искать
          </Button>
        </div>
        {status ? (
          <div style={{ color: status.startsWith('Не ') || status.startsWith('Ошибка') ? 'var(--danger, #b00)' : 'var(--muted)', marginTop: 8 }}>
            {status}
          </div>
        ) : null}
      </SectionCard>

      {mode === 'folders' && folderResult ? (
        <>
          <SectionCard title={`Найденные папки и файлы (${folderResult.matches.length})`}>
            {folderResult.matches.length === 0 ? (
              <div style={{ color: 'var(--muted)' }}>
                По запросу «{folderResult.query}» в выбранных папках ничего не нашлось.
              </div>
            ) : (
              <>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    marginBottom: 10,
                    padding: '8px 10px',
                    border: '1px solid #bfdbfe',
                    borderRadius: 12,
                    background: '#eff6ff',
                  }}
                >
                  <strong style={{ fontSize: 13 }}>Отмечено картинок: {picked.size}</strong>
                  {/* Управляющие кнопки влево (владелец 24.11.2026, промт КАРМАНА #141):
                      «Отправить на печать» — сразу за счётчиком, не у правого края. */}
                  <Button variant="primary" onClick={() => void printPicked()} disabled={busy || picked.size === 0}>
                    Отправить на печать
                  </Button>
                  {osPrintWizard ? (
                    <Button
                      variant="outline"
                      onClick={() => void printPickedViaOs()}
                      disabled={busy || picked.size === 0}
                      title="Системный мастер печати фотографий: в его окне вы правите размер и раскладку"
                    >
                      Через мастер печати фотографий
                    </Button>
                  ) : null}
                  <Button variant="outline" onClick={() => setPicked(new Set())} disabled={picked.size === 0}>
                    Снять отметки
                  </Button>
                </div>
                {folderResult.matches.map((match) => {
                  const images = imagesByMatch[match.key] ?? [];
                  const open = expanded.has(match.key);
                  return (
                    <div key={match.key} style={{ marginBottom: 14, border: '1px solid var(--input-border)', borderRadius: 'var(--ui-radius-sm)' }}>
                      <button
                        type="button"
                        onClick={() => toggleExpanded(match.key)}
                        style={{
                          display: 'flex',
                          gap: 8,
                          alignItems: 'center',
                          width: '100%',
                          padding: '8px 10px',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{open ? '▾' : '▸'}</span>
                        <span style={{ fontSize: 14, fontWeight: 700 }}>{match.name}</span>
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                          {match.matchedBy === 'folder' ? 'папка' : 'файл'} · {match.sourceName} ·{' '}
                          {match.imageCount > 0 ? `картинок: ${match.imageCount}` : 'без картинок'}
                        </span>
                      </button>
                      {open ? (
                        <div style={{ padding: '0 10px 10px' }}>
                          <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 6, wordBreak: 'break-all' }}>
                            {match.relativePath}
                          </div>
                          {images.length === 0 ? (
                            <div style={{ color: 'var(--muted)', fontSize: 13 }}>Картинок в находке нет.</div>
                          ) : (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                              {images.map((image) => {
                                const sel = picked.has(image.id);
                                const url = previews[image.id];
                                return (
                                  <div
                                    key={image.id}
                                    onClick={() => togglePicked(image.id)}
                                    title={image.name}
                                    style={{
                                      position: 'relative',
                                      width: 220,
                                      height: 220,
                                      borderRadius: 12,
                                      overflow: 'hidden',
                                      cursor: 'pointer',
                                      border: sel ? '3px solid #2563eb' : '1px solid var(--input-border)',
                                      background: '#f1f5f9',
                                    }}
                                  >
                                    {url ? (
                                      <img src={url} alt={image.name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                                    ) : (
                                      <div
                                        style={{
                                          width: '100%',
                                          height: '100%',
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          fontSize: 12,
                                          color: 'var(--muted)',
                                        }}
                                      >
                                        Загрузка…
                                      </div>
                                    )}
                                    <div
                                      style={{
                                        position: 'absolute',
                                        top: 6,
                                        left: 6,
                                        width: 22,
                                        height: 22,
                                        borderRadius: 6,
                                        background: sel ? '#2563eb' : 'rgba(255,255,255,0.9)',
                                        border: '1px solid #2563eb',
                                        color: '#fff',
                                        fontSize: 13,
                                        lineHeight: '20px',
                                        textAlign: 'center',
                                        fontWeight: 700,
                                      }}
                                    >
                                      {sel ? '✓' : ''}
                                    </div>
                                    <div
                                      style={{
                                        position: 'absolute',
                                        left: 0,
                                        right: 0,
                                        bottom: 0,
                                        padding: '3px 6px',
                                        fontSize: 11,
                                        color: '#fff',
                                        background: 'rgba(15,23,42,0.72)',
                                        whiteSpace: 'nowrap',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                      }}
                                    >
                                      {image.name}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </>
            )}
          </SectionCard>

          {folderResult.unreadable.length > 0 ? (
            <SectionCard title="Папки, которые не прочитались">
              <div style={{ fontSize: 13 }}>Поиск по остальным папкам продолжен. Эти папки надо выбрать заново:</div>
              {folderResult.unreadable.map((item) => (
                <div key={item.path} style={{ marginTop: 8, fontSize: 13 }}>
                  <div style={{ color: 'var(--danger, #b00)' }}>{item.path}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 12 }}>{item.reason}</div>
                </div>
              ))}
            </SectionCard>
          ) : null}

          {folderResult.notes.length > 0 ? (
            <SectionCard title="Замечания к просмотру папок">
              {folderResult.notes.map((note) => (
                <div key={note} style={{ fontSize: 13, color: 'var(--muted)' }}>
                  {note}
                </div>
              ))}
            </SectionCard>
          ) : null}
        </>
      ) : null}

      {mode === 'content' && result && result.unreadable.length > 0 ? (
        <SectionCard title="Файлы, которые не прочитались">
          <div style={{ fontSize: 13 }}>
            Поиск по остальным файлам продолжен. Эти файлы надо открыть заново:
          </div>
          {result.unreadable.map((item) => (
            <div key={item.path} style={{ marginTop: 8, fontSize: 13 }}>
              <div style={{ color: 'var(--danger, #b00)' }}>{item.path}</div>
              <div style={{ color: 'var(--muted)', fontSize: 12 }}>{item.reason}</div>
              <Button
                size="sm"
                variant="outline"
                style={{ marginTop: 4 }}
                onClick={() => {
                  const source = sources.find((s) => s.path === item.path);
                  if (source) void reselect(source.id);
                }}
              >
                Открыть заново
              </Button>
            </div>
          ))}
        </SectionCard>
      ) : null}

      {mode === 'content' && result && result.notes.length > 0 ? (
        <SectionCard title="Замечания к прочитанному">
          {result.notes.map((note) => (
            <div key={note} style={{ fontSize: 13, color: 'var(--muted)' }}>
              {note}
            </div>
          ))}
        </SectionCard>
      ) : null}

      {mode === 'content' && result ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)', gap: 16, alignItems: 'start' }}>
          <SectionCard title={`Что нашлось в файлах (${result.matches.length})`}>
            {result.matches.length === 0 ? (
              <div style={{ color: 'var(--muted)' }}>По запросу «{result.query}» в выбранных файлах ничего не нашлось.</div>
            ) : (
              result.matches.map((match) => {
                if (match.kind === 'excel') {
                  const cells = cellsByMatch.get(matchKey(match)) ?? [];
                  return (
                    <div key={matchKey(match)} style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                        {match.sourceName} · лист «{match.sheetName}» · строка {match.rowNumber}
                      </div>
                      <div style={{ border: '1px solid var(--input-border)', borderRadius: 'var(--ui-radius-sm)', padding: '0 8px' }}>
                        {cells.map(renderFindingRow)}
                      </div>
                    </div>
                  );
                }
                const lines = extraLines[matchKey(match)];
                return (
                  <div key={matchKey(match)} style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                      {match.sourceName} · {match.kind === 'word' ? 'документ Word' : 'текстовый файл'} · абзац{' '}
                      {match.paragraphIndex + 1}
                    </div>
                    <div style={{ border: '1px solid var(--input-border)', borderRadius: 'var(--ui-radius-sm)', padding: 8, whiteSpace: 'pre-wrap' }}>
                      {match.text}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                      Текст не сверяется с полями карточки — сверьте его глазами.
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      <Button size="sm" variant="outline" onClick={() => void copyValue(match.text)}>
                        Копировать
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => chooseTransfer(match.text, 'Найденный текст')}>
                        В карточку
                      </Button>
                      {match.hasMoreBelow && !lines ? (
                        <Button size="sm" variant="outline" onClick={() => void showBelow(match)}>
                          Показать строки ниже
                        </Button>
                      ) : null}
                    </div>
                    {lines ? (
                      <div style={{ marginTop: 6, borderLeft: '2px solid var(--input-border)', paddingLeft: 8 }}>
                        {lines.map((line, i) => (
                          <div key={`${line}-${i}`} style={{ fontSize: 13, color: 'var(--muted)' }}>
                            {line}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </SectionCard>

          <SectionCard title="Карточка двигателя из базы">
            {!lookup ? (
              <div style={{ color: 'var(--muted)' }}>Запустите поиск — покажем карточку двигателя с таким же номером.</div>
            ) : !lookup.engine ? (
              <div style={{ fontSize: 13 }}>
                <div>В базе нет карточки с номером «{result?.query ?? query}».</div>
                {lookup.note ? <div style={{ color: 'var(--muted)', marginTop: 6 }}>{lookup.note}</div> : null}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  <strong>{lookup.engine.engineNumber || 'без номера'}</strong>
                  {lookup.engine.internalNumberFull ? ` · внутренний ${lookup.engine.internalNumberFull}` : ''}
                  {lookup.engine.rmzCode ? ` · ${lookup.engine.rmzCode}` : ''}
                </div>

                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>Сверка с файлами</div>
                {groups.different.length > 0 ? (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#b45309' }}>
                      Расходится ({groups.different.length})
                    </div>
                    {groups.different.map((row) => (
                      <div key={row.key} style={{ fontSize: 12, marginTop: 4 }}>
                        <strong>{row.cardLabel ?? row.findingLabel}</strong>: в карточке «{row.cardValue}», в файлах «
                        {row.findingValue}»
                      </div>
                    ))}
                  </div>
                ) : null}
                {groups.card_empty.length > 0 ? (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#15803d' }}>
                      В карточке пусто — есть что перенести ({groups.card_empty.length})
                    </div>
                    {groups.card_empty.map((row) => (
                      <div key={row.key} style={{ fontSize: 12, marginTop: 4 }}>
                        {row.cardLabel ? <strong>{row.cardLabel}</strong> : null}
                        {row.cardLabel ? ': ' : ''}в файлах «{row.findingValue}»
                        {row.cardCode && transferableCodes.has(row.cardCode)
                          ? ' — поле можно перенести'
                          : ' — поля для переноса нет'}
                      </div>
                    ))}
                  </div>
                ) : null}
                {groups.no_match.length > 0 ? (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>Только в файлах ({groups.no_match.length})</div>
                    {groups.no_match.map((row) => (
                      <div key={row.key} style={{ fontSize: 12, marginTop: 4, color: 'var(--muted)' }}>
                        {row.findingLabel}: «{row.findingValue}» — в карточке такого пункта нет
                      </div>
                    ))}
                  </div>
                ) : null}
                {groups.same.length > 0 ? (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#15803d' }}>
                      Совпадает с карточкой ({groups.same.length})
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {groups.same.map((row) => row.findingLabel).filter(Boolean).join(', ')}
                    </div>
                  </div>
                ) : null}
                {groups.card_only.length > 0 ? (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted)' }}>
                      Только в карточке ({groups.card_only.length})
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {groups.card_only
                        .slice(0, showAllCardOnly ? groups.card_only.length : 12)
                        .map((row) => row.cardLabel)
                        .filter(Boolean)
                        .join(', ')}
                      {groups.card_only.length > 12 ? (
                        <button
                          type="button"
                          onClick={() => setShowAllCardOnly((prev) => !prev)}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--primary, #2563eb)',
                            cursor: 'pointer',
                            padding: 0,
                            fontSize: 12,
                          }}
                        >
                          {showAllCardOnly ? ' — свернуть' : ` — показать все (${groups.card_only.length})`}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 4px' }}>Заполненные характеристики</div>
                {filled.length === 0 ? (
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>В карточке пока ничего не заполнено.</div>
                ) : (
                  <table className="table" style={{ width: '100%' }}>
                    <tbody>
                      {filled.map((row) => {
                        const cmp = comparisonByCardCode.get(row.code);
                        const badge = cmp ? CARD_BADGE[cmp.state] : null;
                        return (
                          <tr key={row.code}>
                            <td style={{ color: 'var(--muted)', fontSize: 12, width: '40%', wordBreak: 'break-word' }}>
                              {row.label}
                            </td>
                            <td style={{ wordBreak: 'break-word' }}>
                              {row.value}
                              {badge ? (
                                <div style={{ fontSize: 11, color: badge.color, marginTop: 2 }}>{badge.text}</div>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                <div style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 4px' }}>
                  Чего в карточке нет ({missing.length})
                </div>
                {missing.length === 0 ? (
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>Все известные характеристики заполнены.</div>
                ) : (
                  <div style={{ fontSize: 13 }}>{missing.map((m) => m.label).join(', ')}</div>
                )}

                <div style={{ fontSize: 12, color: 'var(--muted)', margin: '14px 0 4px' }}>Перенос из файла</div>
                {pending ? (
                  <div style={{ border: '1px solid var(--input-border)', borderRadius: 'var(--ui-radius-sm)', padding: 8 }}>
                    <div style={{ fontSize: 13 }}>
                      <strong>Что будет скопировано → куда:</strong> «{pending.label}» → «{target.label}»
                    </div>
                    <div style={{ fontSize: 13, marginTop: 4, wordBreak: 'break-word' }}>Значение: {pending.value}</div>
                    <label style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
                      Поле карточки
                      <select
                        value={target.code}
                        onChange={(e) => setTargetCode(e.target.value)}
                        style={{ display: 'block', width: '100%', marginTop: 2 }}
                      >
                        {ENGINE_CARD_TRANSFER_TARGETS.map((field) => (
                          <option key={field.code} value={field.code}>
                            {field.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {preview?.compatible ? (
                      <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>
                        Тип совпадает, поле свободно — можно переносить.
                      </div>
                    ) : (
                      <div style={{ color: 'var(--danger, #b00)', fontSize: 12, marginTop: 6 }}>
                        {preview?.reason ?? 'Перенос невозможен'}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      <Button size="sm" variant="primary" disabled={!preview?.compatible} onClick={applyAutoTransfer}>
                        Перенести
                      </Button>
                      <Button size="sm" variant="outline" onClick={applyManualTransfer}>
                        Вставить вручную
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                    Нажмите «В карточку» у найденного значения — покажем, что и куда переносится.
                  </div>
                )}

                <div style={{ fontSize: 12, color: 'var(--muted)', margin: '14px 0 4px' }}>Поля карточки</div>
                <table className="table" style={{ width: '100%' }}>
                  <tbody>
                    {ENGINE_CARD_TRANSFER_TARGETS.map((field) => (
                      <tr key={field.code}>
                        <td style={{ color: 'var(--muted)', fontSize: 12, width: '45%' }}>{field.label}</td>
                        <td>
                          <Input
                            value={draft[field.code] ?? ''}
                            disabled={!canEdit}
                            onChange={(e) => setDraft((prev) => ({ ...prev, [field.code]: e.target.value }))}
                            placeholder={cardValueText(card?.[field.code]) ?? 'пусто'}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {canEdit ? (
                  <Button
                    variant="primary"
                    style={{ marginTop: 10 }}
                    onClick={() => void saveCard()}
                    disabled={busy || !lookup.engine}
                  >
                    Скопировать данные в карточку двигателя
                  </Button>
                ) : (
                  <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
                    Запись в карточку доступна с правом правки двигателей.
                  </div>
                )}
              </>
            )}
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
