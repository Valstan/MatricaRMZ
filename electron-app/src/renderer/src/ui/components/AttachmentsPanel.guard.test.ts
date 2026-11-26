import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож кнопки «Взять с Верстака».
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
const INTENT = src('./DesktopAttachIntent.ts');
const PRELOAD = src('../../../../preload/index.ts');
const IPC = src('../../../../main/ipc/register/files.ts');
const SCANNER_IPC = src('../../../../main/ipc/register/scanner.ts');
const SCANNER_SERVICE = src('../../../../main/services/scannerService.ts');
const RENAME_DIALOG = src('./FileRenameUploadDialog.tsx');
const UPLOAD_FLOW = src('../hooks/useFileUploadFlow.tsx');

describe('карточка берёт с Верстака, а не Верстак пишет в карточку', () => {
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
    // Тем же вызовом сервер проверяет доступ: ярлык на Верстаке прав на файл НЕ даёт, а
    // вложение карточки — само по себе основание доступа. Собери мы FileRef из плитки —
    // «взять с Верстака» стало бы способом выдать себе чужой файл.
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

describe('оператору не врут об исходе', () => {
  it('правка, ушедшая на утверждение, не называется успехом', () => {
    // Карточка с чужим владельцем строки возвращает {ok:true, queued:true}: файла на
    // карточке ещё нет. Все остальные пути записи в этой панели ветку queued имеют.
    expect(PANEL).toContain('r.queued');
    expect(PANEL).toContain('Отправлено на утверждение');
  });

  it('при частичном успехе называется и удача, и неудача', () => {
    // Иначе оператор с пятью ярлыками, из которых два мертвы, увидит только список
    // отказов и решит, что не приложилось ничего.
    expect(PANEL).toContain('Не приложены:');
    expect(PANEL).toContain('${taken.length > 0 ?');
  });

  it('выбор гейтится тем же правом, что и кнопка', () => {
    // Право могло уйти, пока выбор открыт: «Приложить» иначе молча ничего не делает.
    expect(PANEL).toContain('desktopPickerOpen && props.canUpload && !isAndroid');
  });

  it('кнопка не показывается на планшете — канала files.meta там нет', () => {
    // Якорь — сама кнопка (с эмодзи), а не первое упоминание фразы: выше по файлу она
    // встречается в комментарии к обработчику.
    const at = PANEL.indexOf('🖥 Взять с Верстака');
    expect(at, 'кнопка не найдена — сторож смотрит не туда').toBeGreaterThan(0);
    expect(PANEL.slice(0, at)).toContain('props.canUpload && !isAndroid && (');
  });

  it('в выборе видно и подпись плитки, и настоящее имя файла', () => {
    expect(PANEL).toContain('f.label !== f.name');
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

describe('прикрепление выделенного с Верстака (промт КАРМАНА #144)', () => {
  it('панель забирает намерение по своему scope — чужая карточка его не примет', () => {
    // У карточки свой `scope` (род, id, категория). Без сверки записка уехала бы в первую же
    // открытую карточку и приложила файлы не туда.
    expect(PANEL).toContain('useDesktopAttachIntent(props.scope)');
    expect(INTENT).toContain('intent.ownerType !== scope.ownerType');
    expect(INTENT).toContain('intent.category !== scope.category');
  });

  it('файлы приходят уже отмеченными — оператору не надо отмечать их заново', () => {
    expect(PANEL).toContain('setDesktopPicked(new Set(attachIntent.fileIds))');
    expect(PANEL).toContain('setDesktopPickerOpen(true)');
  });

  it('записка одноразовая: забравший её снимает', () => {
    expect(PANEL).toContain('takeDesktopAttachIntent()');
    expect(INTENT).toContain('export function takeDesktopAttachIntent');
  });

  it('доступ к файлу всё равно проверяет сервер — записка его не обходит', () => {
    // Записка говорит «какие файлы», но не «можно ли их приложить»: проверка остаётся в
    // files.meta, иначе «прикрепить с Верстака» стало бы способом выдать себе чужой файл.
    expect(PANEL).toContain('window.matrica.files.meta({ fileId: f.fileId })');
  });
});

describe('сканирование документа в объект (промт КАРМАНА #148)', () => {
  it('в панели есть действие «Со сканера»', () => {
    expect(PANEL).toContain('Со сканера');
  });

  it('выбор «с диска / со сканера» разруливает ОДНА кнопка', () => {
    // Не двумя кнопками «Добавить файл» и «Со сканера»: оператор говорит «со
    // сканера» и не знает, где сканер. Одна кнопка открывает выбор источника.
    expect(PANEL).toContain('data-attachments-add-choice');
    expect(PANEL).toContain('С диска');
    expect(PANEL).toContain('🖨 Со сканера');
    expect(PANEL).toContain('setAddChoiceOpen((v) => !v)');
    // Файловый диалог зовётся из одного места: кнопка «Добавить файл» сначала
    // спрашивает источник, и только потом открывает диалог выбора файла.
    const picks = PANEL.match(/window\.matrica\.files\.pick\(\)/g) ?? [];
    expect(picks.length, 'файловый диалог зовётся из одного места').toBe(1);
  });

  it('подсказка говорит оператору, что делать, и ждёт его', () => {
    expect(PANEL).toContain('положите документ в сканер и нажмите');
    expect(PANEL).toContain('Сканировать');
    // Окно скана открывается, а скан сам по себе не запускается — жмёт оператор.
    expect(PANEL).toContain('setScanDialogOpen(true)');
  });

  it('имя предлагается автоматически, но текст выделен — печатать можно сразу', () => {
    expect(PANEL).toContain('uploadFlow.promptName(shot.fileName');
    expect(PANEL).toContain('autoSelect: true');
    // Выделение — в самом окне имени: input.select() выделяет предложенный текст.
    expect(RENAME_DIALOG).toContain('input.select()');
    // Окно имени — то же, что у файла с диска: отдельного окна для скана нет.
    expect(UPLOAD_FLOW).toContain('FileRenameUploadDialog');
    expect(UPLOAD_FLOW).toContain('async function promptName(');
  });

  it('скан идёт в объект тем же путём, что и файл с диска', () => {
    // Общий шаг загрузки и записи в карточку — один на оба источника. Свой путь
    // у скана означал бы, что синк его не утащит.
    expect(PANEL).toContain('async function uploadTasks(');
    expect(PANEL).toContain('await uploadTasks([{ path: placed.path, fileName: placed.fileName }])');
    expect(PANEL).toContain('await uploadTasks(uploads)');
  });

  it('канал скана живёт в main и проходит через preload', () => {
    // WIA — COM-объект Windows: в renderer его нет, нативные возможности живут
    // в main-процессе.
    expect(SCANNER_IPC).toContain("ipcMain.handle('scan:document'");
    expect(SCANNER_IPC).toContain("ipcMain.handle('scan:place'");
    expect(PRELOAD).toContain("ipcRenderer.invoke('scan:document'");
    expect(PRELOAD).toContain("ipcRenderer.invoke('scan:place'");
    expect(SCANNER_SERVICE).toContain('WIA.DeviceManager');
  });

  it('скан не обходит право на загрузку', () => {
    // Скан — это вложение: право на загрузку то же, что у файла с диска.
    expect(SCANNER_IPC).toContain("requirePermOrResult(ctx, 'files.upload')");
  });

  it('на планшете недоступность скана названа прямо', () => {
    // Не «кнопка пропала» (оператор решит, что функцию забыли) и не «ошибка»,
    // а объяснение: сканера на планшете нет, сканировать надо на компьютере.
    expect(PANEL).toContain('Сканера на планшете нет');
    expect(PANEL).toContain('void runScan()');
  });

  it('отменённый скан не оставляет мусора в папке объекта', () => {
    expect(PANEL).toContain('window.matrica.scan.discard');
  });
});

describe('действия над отмеченными файлами (промт КАРМАНА #160)', () => {
  const MENU = src('./FileActionsMenu.tsx');
  const IPC_FILES = src('../../../../main/ipc/register/files.ts');

  it('меню одно на все точки включения — второго не заводим', () => {
    // Набор действий — продуктовое решение: две копии разъезжаются (в одной
    // появится «отправить», в другой забудут). Панель вложений берёт тот же
    // компонент, что и выдача «Поиска по файлам».
    expect(PANEL).toContain("from './FileActionsMenu.js'");
    expect(PANEL).toContain('<FileActionsMenu');
    expect(MENU).toContain('export const FILE_ACTIONS');
  });

  it('меню открывается и правой кнопкой по строке, и кнопкой над отметками', () => {
    expect(PANEL).toContain('onContextMenu={(e) => onRowContextMenu(f, e)}');
    expect(PANEL).toContain('Действия…');
    expect(PANEL).toContain('openFileMenuFromButton');
  });

  it('правой кнопкой по неотмеченному файлу отметка ДОБАВЛЯЕТСЯ, а не теряется', () => {
    // Оператор отметил пять файлов и ткнул правой кнопкой в шестой — он хочет
    // шесть. Сбрасывать отметки здесь означало бы «потерять работу».
    expect(PANEL).toContain('setSelected((prev) => new Set(prev).add(file.id))');
  });

  it('печать — та же дверь, что у кнопки «Печать…», а не второй механизм', () => {
    expect(PANEL).toContain("if (id === 'print')");
    expect(PANEL).toContain('setPrintDialogOpen(true)');
  });

  it('почта готовит файлы и открывает клиент — и говорит, что вложений не будет', () => {
    expect(PANEL).toContain('mail.prepareLocalAttachment');
    expect(PANEL).toContain('draft.note');
    expect(PANEL).toContain('Письмо открыто без вложений');
  });

  it('ИИваныч получает файл по «выданному» пути, а вопрос спрашивает у оператора', () => {
    // ИИваныч берёт файл по пути, который выдал главный процесс: иначе вопрос
    // уехал бы без файла («путь не из диалога выбора файлов»).
    expect(PANEL).toContain('files.stageForShare');
    expect(PANEL).toContain('aiChat');
    expect(PANEL).toContain('create({ questionText: question, filePath: path })');
    expect(PANEL).toContain('Вопрос ИИванычу по файлу');
  });

  it('отправка коллеге доступна из карточки — раньше только с Верстака', () => {
    expect(PANEL).toContain('desktopTransfer');
    expect(PANEL).toContain('sendToColleague');
    expect(PANEL).toContain('SendFileToColleagueDialog');
  });

  it('личные сообщения чата — тоже файлом', () => {
    expect(PANEL).toContain('chat.sendFile');
  });

  it('файл можно положить на верстак прямо из вложений', () => {
    expect(PANEL).toContain('requestDesktopPutFiles');
  });

  it('каждое действие доводит файл до конца и говорит результат', () => {
    // Молчать нельзя: оператор не отличит «ушло» от «зависло».
    expect(PANEL).toContain('Отправлено коллеге файлов:');
    expect(PANEL).toContain('Отправлено в личные сообщения:');
    expect(PANEL).toContain('Вопрос отправлен ИИванычу');
    expect(PANEL).toContain('На Верстак отправлено файлов:');
  });

  it('на планшете недоступность названа, а не спрятана', () => {
    expect(PANEL).toContain('На планшете доступны только отправка коллеге');
    expect(PANEL).toContain("return id === 'colleague' || id === 'desktop'");
  });

  it('новый файловый слой живёт в main и проходит через preload', () => {
    // Копии для почты/чата/ИИ собирает главный процесс: renderer не ходит на диск.
    expect(IPC_FILES).toContain("ipcMain.handle('files:stageForShare'");
    expect(IPC_FILES).toContain("requirePermOrResult(ctx, 'files.view')");
    expect(PRELOAD).toContain("ipcRenderer.invoke('files:stageForShare'");
    expect(PANEL).toContain('files.stageForShare');
  });

  it('меню рисуется порталом — правило проекта', () => {
    // Гейт `popupLayer.guard.test.ts` требует портал у самого компонента меню.
    expect(MENU).toContain('PopupLayer');
  });
});
