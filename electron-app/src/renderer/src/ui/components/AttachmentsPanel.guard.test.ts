import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож кнопки «Взять с Рабочего стола».
//
// Направление жеста здесь — не вкусовщина, а требование целостности: у контрагента,
// сотрудника и инструмента список вложений живёт в памяти ОТКРЫТОЙ карточки и уходит в БД
// снимком при её закрытии. Поэтому файл кладёт сама карточка через props.onChange, а не
// кто-то снаружи. Тест держит эту границу и три звена, которые рвутся молча.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PANEL = src('./AttachmentsPanel.tsx');
const APP = src('../App.tsx');
const CONTEXT = src('./DesktopFilesContext.tsx');
const PRELOAD = src('../../../../preload/index.ts');
const IPC = src('../../../../main/ipc/register/files.ts');

describe('карточка берёт со стола, а не стол пишет в карточку', () => {
  it('панель кладёт файл собственным механизмом карточки', () => {
    expect(PANEL).toContain('props.onChange(merged)');
  });

  it('список ярлыков приходит контекстом, а не пропом', () => {
    // Проп пришлось бы прокинуть через девять страниц-карточек — девять мест, где его
    // можно забыть, и забытый проп не ломает ни типы, ни тесты.
    expect(PANEL).toContain('useDesktopFiles()');
    expect(PANEL).not.toContain('props.desktopFiles');
  });

  it('провайдер контекста действительно смонтирован в App', () => {
    // Контекст без провайдера молча отдаёт пустой список: кнопки просто не будет, и
    // ни типы, ни линт этого не заметят — ровно класс «вычислено и никуда не вставлено».
    expect(APP).toContain('<DesktopFilesProvider value={desktopFiles}>');
    expect(APP).toContain('</DesktopFilesProvider>');
    expect(APP).toContain('desktopLiveFileShortcuts(desktopUi)');
  });

  it('у контекста есть дефолт, чтобы панель вне провайдера не падала', () => {
    expect(CONTEXT).toContain('createContext<ReadonlyArray<DesktopFileShortcut>>([])');
  });
});

describe('приложить можно только то, что оператор вправе открыть', () => {
  it('карточка файла спрашивается у сервера, а не собирается из подписи плитки', () => {
    // Тем же вызовом сервер проверяет доступ: ярлык на столе прав на файл НЕ даёт, а
    // вложение карточки — само по себе основание доступа. Собери мы FileRef из плитки —
    // «взять со стола» стало бы способом выдать себе чужой файл.
    expect(PANEL).toContain('window.matrica.files.meta({ fileId: f.fileId })');
  });

  it('отказ объясняется словами, а не сырым HTTP', () => {
    expect(PANEL).toContain('принадлежит другому сотруднику');
    expect(PANEL).toContain('файла больше нет в программе');
  });

  it('канал files:meta проведён через все слои', () => {
    // Мост держится строкой канала: забыть регистрацию в main — получить рантайм-ошибку,
    // которую typecheck не поймает.
    expect(PRELOAD).toContain("ipcRenderer.invoke('files:meta'");
    expect(IPC).toContain("ipcMain.handle('files:meta'");
    expect(IPC).toContain("requirePermOrResult(ctx, 'files.view')");
  });
});

describe('повторное взятие не плодит дублей', () => {
  it('добавление идёт с дедупом по id', () => {
    // Ветка uploadBlobs в этой же панели дедупа НЕ делает — копировать её было нельзя.
    expect(PANEL).toContain('if (!merged.find((x) => x.id === f.id)) merged.push(f)');
  });

  it('уже приложенный файл в списке выбора недоступен', () => {
    expect(PANEL).toContain('уже приложен');
  });
});
