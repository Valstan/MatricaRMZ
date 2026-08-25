import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { FileRef } from '@matricarmz/shared';

import { Button } from './Button.js';
import { useConfirm } from './ConfirmContext.js';
import { useDesktopFiles } from './DesktopFilesContext.js';
import { useFileUploadFlow } from '../hooks/useFileUploadFlow.js';
import { isAndroidPlatform } from '../platform.js';
import { escapeHtml, printSectionsDirect } from '../utils/printPreview.js';

type AttachmentFileRef = FileRef & { isObsolete?: boolean };
type FileFilterMode = 'actual' | 'obsolete' | 'all';

function isFileRef(x: any): x is AttachmentFileRef {
  return x && typeof x === 'object' && typeof x.id === 'string' && typeof x.name === 'string';
}

function normalizeList(v: unknown): AttachmentFileRef[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isFileRef);
}

function formatBytes(n: number): string {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function fileExt(name: string): string {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  if (dot < 0) return '';
  return s.slice(dot + 1).trim().toLowerCase();
}

function extBadgeStyle(ext: string): { label: string; bg: string; fg: string } {
  const e = ext.toLowerCase();
  if (e === 'pdf') return { label: 'PDF', bg: '#fee2e2', fg: '#991b1b' };
  if (e === 'doc' || e === 'docx') return { label: 'Word', bg: '#dbeafe', fg: '#1d4ed8' };
  if (e === 'xls' || e === 'xlsx') return { label: 'Excel', bg: '#dcfce7', fg: '#166534' };
  if (e === 'ppt' || e === 'pptx') return { label: 'PPT', bg: '#ffedd5', fg: '#9a3412' };
  if (e === 'zip' || e === 'rar' || e === '7z') return { label: e.toUpperCase(), bg: '#ede9fe', fg: '#5b21b6' };
  // CAD/CAM & drawings
  if (e === 'dwg' || e === 'dxf' || e === 'dwf' || e === 'stp' || e === 'step' || e === 'igs' || e === 'iges') {
    return { label: e.toUpperCase(), bg: '#e0f2fe', fg: '#075985' };
  }
  // Kompas-3D (common extensions)
  if (e === 'cdw' || e === 'frw' || e === 'm3d' || e === 'a3d' || e === 'k3d') return { label: 'KOMPAS', bg: '#ecfeff', fg: '#155e75' };
  // SolidWorks / Inventor / CATIA / NX (icons only)
  if (e === 'sldprt' || e === 'sldasm' || e === 'slddrw') return { label: 'SW', bg: '#ffe4e6', fg: '#9f1239' };
  if (e === 'ipt' || e === 'iam' || e === 'idw' || e === 'ipn') return { label: 'INV', bg: '#ffedd5', fg: '#9a3412' };
  if (e === 'catpart' || e === 'catproduct' || e === 'catdrawing') return { label: 'CAT', bg: '#ede9fe', fg: '#5b21b6' };
  if (e === 'prt' || e === 'asm') return { label: 'NX', bg: '#e0e7ff', fg: '#3730a3' };
  // Raster/graphics
  if (e === 'psd') return { label: 'PSD', bg: '#0b1220', fg: '#93c5fd' };
  if (e === 'ai') return { label: 'AI', bg: '#ffedd5', fg: '#9a3412' };
  if (e === 'cdr') return { label: 'CDR', bg: '#dcfce7', fg: '#166534' };
  if (e === 'svg') return { label: 'SVG', bg: '#fef3c7', fg: '#92400e' };
  // CAM / CNC programs (often text)
  if (e === 'nc' || e === 'cnc' || e === 'tap' || e === 'gcode' || e === 'ngc' || e === 'mpf' || e === 'spf') {
    return { label: 'NC', bg: '#0f172a', fg: '#e2e8f0' };
  }
  if (e === 'exe' || e === 'msi') return { label: e.toUpperCase(), bg: '#e5e7eb', fg: '#111827' };
  if (e === 'png' || e === 'jpg' || e === 'jpeg' || e === 'webp' || e === 'gif') return { label: 'IMG', bg: '#e0e7ff', fg: '#3730a3' };
  if (e === 'txt' || e === 'log' || e === 'md') return { label: e.toUpperCase(), bg: '#f1f5f9', fg: '#0f172a' };
  return { label: (e || 'FILE').slice(0, 6).toUpperCase(), bg: '#f3f4f6', fg: '#374151' };
}

function isObsoleteFile(file: AttachmentFileRef): boolean {
  return file.isObsolete === true;
}

/** Печатается содержимым только картинка — офисные файлы конвейер main'а не рендерит. */
function isPrintableImage(name: string): boolean {
  return ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'webp'].includes(fileExt(name));
}

/** Снимок с камеры приходит как image.jpg — в списке вложений это бесполезное имя. */
function renameCameraShot(file: File): File {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  const ext = fileExt(file.name) || 'jpg';
  return new File([file], `Фото ${stamp}.${ext}`, { type: file.type });
}

const LIST_TOGGLE_STYLE: React.CSSProperties = {
  marginTop: 10,
  width: '100%',
  padding: '8px 12px',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  background: '#f8fafc',
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 600,
  color: '#334155',
  textAlign: 'left',
};

type AttachmentsPanelProps = {
  title?: string;
  value: unknown; // FileRef[] in JSON
  canView: boolean;
  canUpload: boolean;
  /** Человеческое имя карточки — им подписывается папка файлов объекта и печать. */
  objectLabel?: string;
  scope?: { ownerType: string; ownerId: string; category: string };
  onChange: (next: FileRef[]) => Promise<{ ok: true; queued?: boolean } | { ok: false; error: string } | void> | void;
  /**
   * Управляемая выборка: когда панель живёт внутри `AttachmentsModule`, выбор
   * общий с фотогалереей, а групповые кнопки — один раз в модуле. Без этих
   * пропсов панель работает как раньше, со своей выборкой и своей полосой.
   */
  selected?: Set<string>;
  onSelectedChange?: (next: Set<string>) => void;
  hideBulkBar?: boolean;
};

export function AttachmentsPanel(props: AttachmentsPanelProps) {
  return <AttachmentsPanelInner {...props} />;
}

function AttachmentsPanelInner(props: AttachmentsPanelProps) {
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState<string>('');
  const [filterMode, setFilterMode] = useState<FileFilterMode>('all');
  const uploadFlow = useFileUploadFlow();
  const [thumbs, setThumbs] = useState<Record<string, { dataUrl: string | null; status: 'idle' | 'loading' | 'done' | 'error' }>>({});
  const thumbsRef = useRef(thumbs);

  // Групповые операции: чекбоксы в списке → печать / копирование / отправка пачкой.
  const [ownSelected, setOwnSelected] = useState<Set<string>>(new Set());
  const controlledSelection = props.selected != null && props.onSelectedChange != null;
  const selected = controlledSelection ? (props.selected as Set<string>) : ownSelected;
  const setSelected = (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const next = typeof updater === 'function' ? (updater as (prev: Set<string>) => Set<string>)(selected) : updater;
    if (controlledSelection) props.onSelectedChange?.(next);
    else setOwnSelected(next);
  };
  // «Взять с Рабочего стола»: список ярлыков приходит контекстом из App — панель живёт в
  // девяти карточках, и протаскивать проп через каждую значит завести девять мест, где его
  // можно забыть.
  const desktopFiles = useDesktopFiles();
  const [desktopPickerOpen, setDesktopPickerOpen] = useState(false);
  const [desktopPicked, setDesktopPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [printNames, setPrintNames] = useState(true);
  const [printContents, setPrintContents] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  // На планшете нет ни файловых диалогов, ни кэша на диске, ни Проводника: часть
  // кнопок панели там просто не имеет смысла — гейтим их поштучно, а не панель целиком.
  const isAndroid = isAndroidPlatform();
  const androidPickRef = useRef<HTMLInputElement>(null);
  const androidCameraRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => normalizeList(props.value), [props.value]);
  // Длинный список файлов по умолчанию свёрнут (этап 4 tabs-window-shell): пользователь
  // разворачивает сам; превью не грузятся, пока список свёрнут.
  const LONG_LIST_THRESHOLD = 5;
  const [listExpanded, setListExpanded] = useState(false);
  const listCollapsed = list.length > LONG_LIST_THRESHOLD && !listExpanded;
  const filteredList = useMemo(() => {
    if (filterMode === 'actual') return list.filter((file) => !isObsoleteFile(file));
    if (filterMode === 'obsolete') return list.filter((file) => isObsoleteFile(file));
    return list;
  }, [list, filterMode]);
  const listKey = useMemo(() => list.map((x) => x.id).join('|'), [list]);
  // Выбор живёт по id: файл удалили/отфильтровали — он выпадает и из выборки.
  const selectedIds = useMemo(() => filteredList.filter((f) => selected.has(f.id)).map((f) => f.id), [filteredList, selected]);
  const objectLabel = props.objectLabel?.trim() || props.title?.trim() || 'Карточка';

  useEffect(() => {
    // Управляемой выборкой владеет модуль — он же её и сбрасывает.
    if (!controlledSelection) setOwnSelected(new Set());
  }, [listKey, controlledSelection]);

  useEffect(() => {
    thumbsRef.current = thumbs;
  }, [thumbs]);

  useEffect(() => {
    if (!props.canView || listCollapsed) return;
    let alive = true;
    const run = async () => {
      for (const f of list) {
        if (!alive) return;
        const cur = thumbsRef.current[f.id];
        if (cur && (cur.status === 'loading' || cur.status === 'done' || cur.status === 'error')) continue;
        setThumbs((p) => ({ ...p, [f.id]: { dataUrl: null, status: 'loading' } }));
        try {
          const r = await window.matrica.files.previewGet({ fileId: f.id });
          if (!alive) return;
          if (r.ok) setThumbs((p) => ({ ...p, [f.id]: { dataUrl: r.dataUrl ?? null, status: 'done' } }));
          else setThumbs((p) => ({ ...p, [f.id]: { dataUrl: null, status: 'error' } }));
        } catch {
          if (!alive) return;
          setThumbs((p) => ({ ...p, [f.id]: { dataUrl: null, status: 'error' } }));
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [props.canView, listKey, list, listCollapsed]);

  async function addFromPaths(paths: string[]) {
    if (!props.canUpload) return;
    const uploads = await uploadFlow.buildTasks(paths);
    if (!uploads) {
        setBusy('Загрузка отменена пользователем');
        setTimeout(() => setBusy(''), 1400);
        return;
    }
    setBusy('Загрузка файлов...');
    try {
      const uploadResult = await uploadFlow.runUploads<FileRef>(uploads, async (task) => {
        const r = await window.matrica.files.upload({ path: task.path, fileName: task.fileName, ...(props.scope ? { scope: props.scope } : {}) });
        return r.ok ? { ok: true as const, value: r.file } : { ok: false as const, error: r.error };
      });
      if (uploadResult.failures.length > 0) {
        const firstFailure = uploadResult.failures[0];
        throw new Error(firstFailure ? firstFailure.error : 'upload failed');
      }
      const added = uploadResult.successes.map((x) => x.value);
      const merged = [...list];
      for (const f of added) {
        if (!merged.find((x) => x.id === f.id)) merged.push(f);
      }
      uploadFlow.setProgress({ active: true, percent: 98, label: 'Сохранение изменений...' });
      const r = await Promise.resolve(props.onChange(merged)).catch((e) => ({ ok: false as const, error: String(e) }));
      uploadFlow.setProgress({ active: false, percent: 0, label: '' });
      if (!r) {
        setBusy(`Успешно: прикреплено файлов — ${added.length}`);
        setTimeout(() => setBusy(''), 700);
        return;
      }
      if (!r.ok) {
        setBusy(`Неуспешно: ${r.error}`);
        setTimeout(() => setBusy(''), 4500);
        return;
      }
      if (r.queued) {
        setBusy('Успешно: отправлено на утверждение (см. «Изменения»)');
        setTimeout(() => setBusy(''), 1600);
        return;
      }
      setBusy(`Успешно: прикреплено файлов — ${added.length}`);
      setTimeout(() => setBusy(''), 1200);
    } catch (e) {
      uploadFlow.setProgress({ active: false, percent: 0, label: '' });
      const reason = e instanceof Error ? e.message : String(e);
      setBusy(`Неуспешно: ${reason}`);
      setTimeout(() => setBusy(''), 4500);
    }
  }

  async function toggleObsoleteFlag(fileId: string, nextObsolete: boolean) {
    if (!props.canUpload) return;
    try {
      const next = list.map((file) => {
        if (file.id !== fileId) return file;
        if (nextObsolete) return { ...file, isObsolete: true } as AttachmentFileRef;
        const { isObsolete: _isObsolete, ...clean } = file;
        return clean as AttachmentFileRef;
      });
      setBusy(nextObsolete ? 'Сохраняем пометку «Устаревшая версия»...' : 'Снимаем пометку...');
      const upd = await Promise.resolve(props.onChange(next));
      if (!upd) {
        setBusy(nextObsolete ? 'Файл помечен как «Устаревшая версия»' : 'Пометка снята');
        setTimeout(() => setBusy(''), 1400);
        return;
      }
      if (!upd.ok) {
        setBusy(`Ошибка: ${upd.error}`);
        setTimeout(() => setBusy(''), 3500);
        return;
      }
      if (upd.queued) {
        setBusy('Отправлено на утверждение (см. «Изменения»)');
        setTimeout(() => setBusy(''), 2200);
        return;
      }
      setBusy(nextObsolete ? 'Файл помечен как «Устаревшая версия»' : 'Пометка снята');
      setTimeout(() => setBusy(''), 1400);
    } catch (e) {
      setBusy(`Ошибка: ${String(e)}`);
      setTimeout(() => setBusy(''), 3500);
    }
  }

  /**
   * Планшет. Пути к файлу у WebView нет: содержимое читаем из Blob и грузим им же.
   * Диалог переименования тут не показываем — в цеху лишний шаг ни к чему, имя
   * берём как есть (для камеры оно осмысленное: «Фото <дата время>.jpg»).
   */
  async function uploadBlobs(files: File[]) {
    if (!props.canUpload || files.length === 0) return;
    setBusy('Загрузка файлов...');
    try {
      const added: FileRef[] = [];
      for (const file of files) {
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('не удалось прочитать файл'));
          reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
          reader.readAsDataURL(file);
        });
        const r = await window.matrica.files.uploadBlob({
          name: file.name,
          ...(file.type ? { mime: file.type } : {}),
          dataBase64,
          ...(props.scope ? { scope: props.scope } : {}),
        });
        if (!r.ok) throw new Error(r.error);
        added.push(r.file);
      }
      await Promise.resolve(props.onChange([...list, ...added]));
      setBusy(`Успешно: прикреплено файлов — ${added.length}`);
      setTimeout(() => setBusy(''), 1400);
    } catch (e) {
      setBusy(`Неуспешно: ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => setBusy(''), 4500);
    }
  }

  async function addFromDrop(dropped: FileList | null) {
    if (!props.canUpload || !dropped || dropped.length === 0) return;
    const r = await window.matrica.files.dropped(Array.from(dropped));
    if (!r.ok) {
      setBusy(`Ошибка: ${r.error}`);
      setTimeout(() => setBusy(''), 3500);
      return;
    }
    await addFromPaths(r.paths);
  }

  /**
   * «Взять с Рабочего стола». Карточка забирает файл сама и кладёт его СВОИМ обычным
   * механизмом (props.onChange) — обратное направление невозможно: у трёх карточек список
   * вложений живёт в памяти открытой карточки и уходит в БД снимком при её закрытии.
   *
   * Карточка файла спрашивается у сервера, а не собирается из подписи плитки. Так и полный
   * FileRef получается настоящим, и — главное — проверяется ДОСТУП: ярлык на столе прав на
   * файл не даёт, поэтому приложить можно только то, что оператор и так вправе открыть.
   * Без этой проверки «взять со стола» стало бы способом выдать себе доступ: вложение
   * карточки само является для сервера основанием доступа.
   */
  async function takeFromDesktop() {
    if (!props.canUpload || desktopPicked.size === 0) return;
    const picked = desktopFiles.filter((f) => desktopPicked.has(f.fileId) && !list.some((x) => x.id === f.fileId));
    if (picked.length === 0) {
      setDesktopPickerOpen(false);
      setDesktopPicked(new Set());
      return;
    }
    setBusy('Берём файлы с Рабочего стола...');
    const taken: FileRef[] = [];
    const failures: string[] = [];
    for (const f of picked) {
      const r = await window.matrica.files.meta({ fileId: f.fileId }).catch((e) => ({ ok: false as const, error: String(e) }));
      if (r.ok) {
        taken.push(r.file);
        continue;
      }
      const error = String(r.error);
      failures.push(
        /403/.test(error)
          ? `«${f.label}» — файл принадлежит другому сотруднику`
          : /404/.test(error)
            ? `«${f.label}» — файла больше нет в программе`
            : `«${f.label}» — ${error}`,
      );
    }

    if (taken.length > 0) {
      const merged = [...list];
      for (const f of taken) if (!merged.find((x) => x.id === f.id)) merged.push(f);
      const r = await Promise.resolve(props.onChange(merged)).catch((e) => ({ ok: false as const, error: String(e) }));
      if (r && !r.ok) {
        setBusy(`Неуспешно: ${r.error}`);
        setTimeout(() => setBusy(''), 4500);
        return;
      }
    }
    setDesktopPickerOpen(false);
    setDesktopPicked(new Set());
    if (failures.length > 0) {
      setBusy(`Не приложены: ${failures.join('; ')}`);
      setTimeout(() => setBusy(''), 6000);
      return;
    }
    setBusy(`Успешно: приложено файлов — ${taken.length}`);
    setTimeout(() => setBusy(''), 1600);
  }

  async function addFromClipboard() {
    if (!props.canUpload) return;
    const r = await window.matrica.files.clipboardRead();
    if (!r.ok) {
      setBusy(`Ошибка: ${r.error}`);
      setTimeout(() => setBusy(''), 3500);
      return;
    }
    await addFromPaths(r.paths);
  }

  function toggleSelected(fileId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  async function runBatch(label: string, run: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setBusy(`${label}...`);
    try {
      const r = await run();
      if (!r.ok) {
        setBusy(r.error === 'cancelled' ? '' : `Ошибка: ${r.error}`);
        setTimeout(() => setBusy(''), 3000);
        return;
      }
      setBusy(`${label}: готово`);
      setTimeout(() => setBusy(''), 1400);
    } catch (e) {
      setBusy(`Ошибка: ${String(e)}`);
      setTimeout(() => setBusy(''), 3000);
    }
  }

  /** Список и изображения печатаются одним проверенным renderer-конвейером и одним системным диалогом. */
  async function printSelected() {
    const files = filteredList.filter((f) => selected.has(f.id));
    if (files.length === 0 || (!printNames && !printContents)) return;
    const printable = files.filter((f) => isPrintableImage(f.name));
    if (printContents && printable.length === 0 && !printNames) {
      setBusy('Ошибка: среди выбранных нет изображений — печатать нечего');
      setTimeout(() => setBusy(''), 3500);
      return;
    }

    // Окно нужно открыть синхронно по клику, иначе Chromium может счесть его всплывающим и заблокировать после загрузки оригиналов.
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setBusy('Ошибка: не удалось открыть окно печати');
      setTimeout(() => setBusy(''), 3500);
      return;
    }
    printWindow.document.write('<!doctype html><meta charset="utf-8"><title>Печать</title><body style="font-family:system-ui;padding:24px">Подготовка файлов к печати…</body>');
    printWindow.document.close();
    setPrintDialogOpen(false);
    setBusy('Подготовка печати...');

    try {
      const imageSections = [];
      if (printContents) {
        for (const file of printable) {
          const result = await window.matrica.files.originalGet({ fileId: file.id });
          if (!result.ok || !result.dataUrl) throw new Error(result.ok ? 'Файл не содержит изображения' : result.error);
          imageSections.push({
            id: `image-${file.id}`,
            title: file.name,
            html: `<div class="attachment-print-image"><img src="${escapeHtml(result.dataUrl)}" alt="${escapeHtml(file.name)}" /></div>`,
          });
        }
      }
      const sections = [
        ...(printNames
          ? [{
              id: 'files',
              title: `Файлы — ${objectLabel}`,
              html: `<ol>${files.map((f) => `<li>${escapeHtml(f.name)}${isObsoleteFile(f) ? ' — устаревшая версия' : ''}</li>`).join('')}</ol>`,
            }]
          : []),
        ...imageSections,
      ];
      printSectionsDirect({
        title: objectLabel,
        sections,
        targetWindow: printWindow,
        extraCss: `
          .attachment-print-image { height: 245mm; display: flex; align-items: center; justify-content: center; }
          .attachment-print-image img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
          @media print { .section + .section { break-before: page; page-break-before: always; } }
        `,
      });
      const skipped = printContents ? files.length - printable.length : 0;
      setBusy(skipped > 0 ? `Печать: пропущено неподдерживаемых файлов: ${skipped}` : '');
      if (skipped > 0) setTimeout(() => setBusy(''), 3500);
    } catch (e) {
      printWindow.close();
      setBusy(`Ошибка подготовки печати: ${String(e)}`);
      setTimeout(() => setBusy(''), 4000);
    }
  }

  if (!props.canView) return null;

  return (
    <div
      onDragOver={(e) => {
        if (!props.canUpload || isAndroid || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        // Уход внутрь дочернего узла — не выход из зоны.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={(e) => {
        if (!props.canUpload) return;
        e.preventDefault();
        setDragOver(false);
        void addFromDrop(e.dataTransfer.files);
      }}
      style={{
        marginTop: 14,
        border: dragOver ? '2px dashed #2563eb' : '1px solid rgba(15, 23, 42, 0.18)',
        borderRadius: 14,
        padding: dragOver ? 11 : 12,
        background: dragOver ? '#eff6ff' : undefined,
      }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <strong>{props.title ?? 'Вложения'}</strong>
        <span style={{ flex: 1 }} />
        {busy && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: busy.startsWith('Ошибка') || busy.startsWith('Неуспешно') ? '#b91c1c' : '#64748b', fontSize: 12 }}>
            {/* Крутилка на время операции с файлом: «...» в конце = процесс ещё идёт. */}
            {busy.endsWith('...') && <span className="mx-spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />}
            {busy}
          </div>
        )}
        {props.canUpload && isAndroid && (
          <>
            {/* На планшете файлы выбирает сам WebView: галерея, «Файлы» или камера. */}
            <input
              ref={androidPickRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = '';
                void uploadBlobs(picked);
              }}
            />
            <input
              ref={androidCameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = '';
                void uploadBlobs(picked.map((f) => renameCameraShot(f)));
              }}
            />
            <Button variant="ghost" onClick={() => androidPickRef.current?.click()}>
              Добавить файл
            </Button>
            <Button variant="ghost" onClick={() => androidCameraRef.current?.click()}>
              📷 Сделать фото
            </Button>
          </>
        )}
        {props.canUpload && !isAndroid && (
          <>
            <Button
              variant="ghost"
              onClick={async () => {
                const pickResult = await window.matrica.files.pick();
                if (pickResult.ok && pickResult.paths) {
                  await addFromPaths(pickResult.paths);
                }
              }}
            >
              Добавить файл
            </Button>
            <Button variant="ghost" title="Загрузить то, что скопировано в буфер обмена" onClick={() => void addFromClipboard()}>
              Вставить из буфера
            </Button>
            {desktopFiles.length > 0 && (
              <Button
                variant="ghost"
                title="Приложить файл, который лежит у вас на Рабочем столе"
                onClick={() => setDesktopPickerOpen((v) => !v)}
              >
                🖥 Взять с Рабочего стола
              </Button>
            )}
          </>
        )}
        {/* Раньше «Папка скачивания» лишь МЕНЯЛА корневую папку и ничего не открывала.
            Теперь основная кнопка открывает папку файлов именно этой карточки, а смена
            корня осталась отдельным пунктом. На планшете папок с файлами нет. */}
        {!isAndroid && (
        <><Button
          variant="ghost"
          disabled={list.length === 0}
          title="Открыть папку с файлами этой карточки"
          onClick={() =>
            void runBatch('Открытие папки', () =>
              window.matrica.files.openObjectDir({
                fileIds: (selectedIds.length > 0 ? selectedIds : filteredList.map((f) => f.id)),
                label: objectLabel,
              }),
            )
          }
        >
          Папка файлов
        </Button>
        <Button
          variant="ghost"
          title="Выбрать, куда программа скачивает файлы"
          onClick={async () => {
            const r = await window.matrica.files.downloadDirPick();
            if (!r.ok) setBusy(r.error === 'cancelled' ? '' : `Ошибка: ${r.error}`);
            else setBusy(`Папка загрузок: ${r.path}`);
            setTimeout(() => setBusy(''), 1800);
          }}
        >
          Сменить папку загрузок…
        </Button></>
        )}
      </div>
      {selectedIds.length > 0 && !props.hideBulkBar && (
        <div
          style={{
            marginTop: 10,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            padding: '8px 10px',
            border: '1px solid #bfdbfe',
            borderRadius: 12,
            background: '#eff6ff',
          }}
        >
          <strong style={{ fontSize: 13 }}>Выбрано файлов: {selectedIds.length}</strong>
          <span style={{ flex: 1 }} />
          {!isAndroid && (
            <>
              <Button variant="ghost" onClick={() => setPrintDialogOpen(true)}>
                Печать…
              </Button>
              <Button variant="ghost" onClick={() => void runBatch('Копирование в папку', () => window.matrica.files.copyToFolder({ fileIds: selectedIds }))}>
                Копировать в папку…
              </Button>
              <Button
                variant="ghost"
                onClick={() => void runBatch('Подготовка к отправке', () => window.matrica.files.revealForShare({ fileIds: selectedIds, label: objectLabel }))}
              >
                Отправить…
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            Снять выбор
          </Button>
        </div>
      )}
      {desktopPickerOpen && (
        <div data-attachments-desktop-picker style={{ marginTop: 10, padding: 12, border: '1px solid #e5e7eb', borderRadius: 12, background: '#f8fafc' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Файлы на вашем Рабочем столе</div>
          <div style={{ display: 'grid', gap: 6, marginBottom: 12, maxHeight: 220, overflowY: 'auto' }}>
            {desktopFiles.map((f) => {
              const already = list.some((x) => x.id === f.fileId);
              return (
                <label
                  key={f.shortcutId}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: already ? 'default' : 'pointer', opacity: already ? 0.55 : 1 }}
                  title={already ? 'Этот файл уже приложен к карточке' : f.name}
                >
                  <input
                    type="checkbox"
                    disabled={already}
                    checked={desktopPicked.has(f.fileId)}
                    onChange={(e) =>
                      setDesktopPicked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(f.fileId);
                        else next.delete(f.fileId);
                        return next;
                      })
                    }
                  />
                  <span>{f.label}</span>
                  {already ? <span style={{ fontSize: 12, color: '#64748b' }}>— уже приложен</span> : null}
                </label>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button disabled={desktopPicked.size === 0} onClick={() => void takeFromDesktop()}>
              Приложить ({desktopPicked.size})
            </Button>
            <Button variant="ghost" onClick={() => { setDesktopPickerOpen(false); setDesktopPicked(new Set()); }}>
              Отмена
            </Button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#64748b' }}>
            Файл останется и на Рабочем столе — карточка получает ссылку на него, а не копию.
          </div>
        </div>
      )}
      {printDialogOpen && (
        <div style={{ marginTop: 10, padding: 12, border: '1px solid #e5e7eb', borderRadius: 12, background: '#f8fafc' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Что напечатать по выбранным файлам ({selectedIds.length})?</div>
          <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={printNames} onChange={(e) => setPrintNames(e.target.checked)} />
              <span>Список названий файлов</span>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={printContents} onChange={(e) => setPrintContents(e.target.checked)} />
              <span>Содержимое файлов (изображения)</span>
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button disabled={!printNames && !printContents} onClick={() => void printSelected()}>Печатать</Button>
            <Button variant="ghost" onClick={() => setPrintDialogOpen(false)}>
              Отмена
            </Button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#64748b' }}>
            Можно выбрать один или оба варианта. Изображения печатаются по одному на лист A4. PDF, Word и Excel в печать содержимого не входят — их можно открыть и напечатать отдельно.
          </div>
        </div>
      )}
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#64748b' }}>
          <span>Фильтр:</span>
          <select
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as FileFilterMode)}
            style={{ minWidth: 280, padding: '4px 8px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#0b1220' }}
          >
            <option value="actual">Показывать только актуальные файлы</option>
            <option value="obsolete">Только устаревшие</option>
            <option value="all">Показать все файлы</option>
          </select>
        </label>
        <div style={{ fontSize: 12, color: '#64748b' }}>
          Показано: {filteredList.length} из {list.length}
        </div>
      </div>
      {props.canUpload && !isAndroid && (
        <div style={{ marginTop: 6, fontSize: 12, color: dragOver ? '#1d4ed8' : '#94a3b8' }}>
          {dragOver ? 'Отпустите — файлы загрузятся сюда' : 'Файлы можно перетащить сюда мышью или вставить из буфера обмена'}
        </div>
      )}
      {uploadFlow.progress.active && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#64748b', marginBottom: 4 }}>
            <span>{uploadFlow.progress.label}</span>
            <span>{Math.max(0, Math.min(100, Math.round(uploadFlow.progress.percent)))}%</span>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: '#e5e7eb', overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.max(0, Math.min(100, uploadFlow.progress.percent))}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #0ea5e9 0%, #2563eb 100%)',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
        </div>
      )}

      {/* Кнопка остаётся на месте и после разворота — иначе список не свернуть обратно. */}
      {list.length > LONG_LIST_THRESHOLD && (
        <button type="button" onClick={() => setListExpanded((v) => !v)} style={LIST_TOGGLE_STYLE}>
          {listExpanded ? '▼ Свернуть файлы' : '▶ Показать файлы'} ({filteredList.length})
        </button>
      )}
      {!listCollapsed && (
      <div style={{ marginTop: 10, border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'linear-gradient(135deg, #0f766e 0%, #2563eb 120%)', color: '#fff' }}>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10, width: 36 }}>
                <input
                  type="checkbox"
                  aria-label="Выбрать все файлы"
                  title="Выбрать все файлы"
                  checked={filteredList.length > 0 && selectedIds.length === filteredList.length}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedIds.length > 0 && selectedIds.length < filteredList.length;
                  }}
                  onChange={(e) => setSelected(e.target.checked ? new Set(filteredList.map((f) => f.id)) : new Set())}
                />
              </th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Файл</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10, width: 190 }}>Статус</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10, width: 120 }}>Размер</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10, width: 220 }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {filteredList.map((f) => (
              <tr key={f.id}>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10, verticalAlign: 'top' }}>
                  <input
                    type="checkbox"
                    aria-label={`Выбрать файл ${f.name}`}
                    checked={selected.has(f.id)}
                    onChange={() => toggleSelected(f.id)}
                  />
                </td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {(() => {
                      const t = thumbs[f.id];
                      const dataUrl = t?.dataUrl ?? null;
                      const ext = fileExt(f.name);
                      const badge = extBadgeStyle(ext);
                      return dataUrl ? (
                        <img
                          src={dataUrl}
                          alt=""
                          style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 10, border: '1px solid rgba(15, 23, 42, 0.12)' }}
                        />
                      ) : (
                        <div
                          title={ext ? `.${ext}` : 'файл'}
                          style={{
                            width: 44,
                            height: 44,
                            borderRadius: 10,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 11,
                            fontWeight: 700,
                            background: badge.bg,
                            color: badge.fg,
                            border: '1px solid rgba(15, 23, 42, 0.12)',
                          }}
                        >
                          {badge.label}
                        </div>
                      );
                    })()}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <div style={{ fontSize: 14, color: '#0b1220' }}>{f.name}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{f.mime ? String(f.mime) : ''}</div>
                    </div>
                  </div>
                </td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                  {isObsoleteFile(f) ? (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '3px 8px',
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 600,
                        background: '#fee2e2',
                        color: '#991b1b',
                        border: '1px solid #fecaca',
                      }}
                    >
                      Устаревшая версия
                    </span>
                  ) : (
                    <span style={{ fontSize: 12, color: '#64748b' }}>Актуальная</span>
                  )}
                </td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{formatBytes(Number(f.size) || 0)}</td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        const r = await window.matrica.files.open({ fileId: f.id });
                        if (!r.ok) setBusy(`Ошибка: ${r.error}`);
                      }}
                    >
                      Открыть
                    </Button>
                    {props.canUpload && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          void toggleObsoleteFlag(f.id, !isObsoleteFile(f));
                        }}
                      >
                        {isObsoleteFile(f) ? 'Снять пометку' : 'Пометить устаревшей'}
                      </Button>
                    )}
                    {props.canUpload && (
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          try {
                            const ok = await confirm({
                              detail: `Будет удалён файл «${f.name}»${props.title ? ` из блока «${props.title}»` : ''}. Ссылка уберётся из записи; при отсутствии других ссылок файл может быть удалён на сервере.`,
                            });
                            if (!ok) return;
                            const next = list.filter((x) => x.id !== f.id);
                            setBusy('Удаление из списка...');
                            const upd = await Promise.resolve(props.onChange(next));
                            if (!upd) {
                              setBusy('Сохранено');
                              setTimeout(() => setBusy(''), 700);
                              return;
                            }
                            if (!upd.ok) {
                              setBusy(`Ошибка: ${upd.error}`);
                              setTimeout(() => setBusy(''), 3000);
                              return;
                            }
                            if (upd.queued) {
                              // Важно: pre-approval — запись не поменялась, поэтому файл нельзя удалять физически.
                              setBusy('Отправлено на утверждение (см. «Изменения»)');
                              setTimeout(() => setBusy(''), 2000);
                              return;
                            }

                            // После того как ссылка из записи убрана — можно попытаться удалить файл физически.
                            // Если файл используется где-то ещё, soft-delete может быть нежелательным, но пока оставляем как есть.
                            setBusy('Удаление файла...');
                            const deleteResult = await window.matrica.files.delete({ fileId: f.id });
                            if (!deleteResult.ok) {
                              setBusy(`Файл убран из списка, но удалить на сервере не удалось: ${deleteResult.error}`);
                              setTimeout(() => setBusy(''), 3500);
                              return;
                            }
                            if ((deleteResult as any).queued) {
                              setBusy('Удаление файла отправлено на утверждение (см. «Изменения»)');
                              setTimeout(() => setBusy(''), 2000);
                              return;
                            }
                            setBusy('Файл удален');
                            setTimeout(() => setBusy(''), 700);
                          } catch (e) {
                            setBusy(`Ошибка: ${String(e)}`);
                            setTimeout(() => setBusy(''), 3000);
                          }
                        }}
                      >
                        Удалить файл
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filteredList.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: 12, color: '#6b7280' }}>
                  {list.length === 0
                    ? `Нет вложений. ${props.canUpload ? 'Нажмите “Добавить файл”, чтобы прикрепить документ.' : ''}`
                    : 'По выбранному фильтру файлы не найдены.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}
      {uploadFlow.renameDialog}
    </div>
  );
}


