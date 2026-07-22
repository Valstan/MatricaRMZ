# План — Фотогалерея карточки двигателя (Owner backlog, тема E, #11)

**Статус:** APPROVED 2026-06-17 (владелец выбрал полное меню «Отправить»: флешка/папка + открыть папку + почта)
**Создан:** 2026-06-17 (Claude Opus 4.8)
**Источник:** owner voice-batch, [`PENDING_FOLLOWUPS.md`](../../PENDING_FOLLOWUPS.md) §E. Решение владельца по кнопкам — в этой сессии (см. ниже).

## Контекст / что уже есть

- Вложения двигателя живут в EAV-атрибуте `attachments` (`FileRef[]`), рендерит [`AttachmentsPanel.tsx`](../../electron-app/src/renderer/src/ui/components/AttachmentsPanel.tsx) в [`EngineDetailsPage.tsx:1219`](../../electron-app/src/renderer/src/ui/pages/EngineDetailsPage.tsx). Это **таблица** с превью 44px + действия по строке (Открыть / Пометить устаревшей / Удалить). Массовая **загрузка** есть, массового **просмотра** (галереи) — нет.
- Хранилище: backend HTTP, файл по `fileId`. `files.previewGet` → уменьшенный base64-thumbnail. `filesDownload` → качает **оригинал** в локальный кэш (по sha256), отдаёт `localPath` (кэшируется). `filesOpen` = download + `shell.openPath`.
- Готовые примитивы Electron (переиспользуем): `clipboard` + `nativeImage`, `shell.openPath/openExternal/showItemInFolder`, `dialog.showSaveDialog/showOpenDialog`, `webContents.printToPDF` / `webContents.print`, оффскрин-паттерн `renderHtmlWindow(html)` (в reportService/toolsService/reportsBuilderService), `app.getPath('desktop')`.
- Права: `files.view` / `files.upload` / `files.delete` (переиспользуем; copy/print/собрать/отправить = read-уровень `files.view`, удаление = `files.delete`). Pre-approval/queued-путь для не-админов — соблюдаем (как в `AttachmentsPanel.onChange`).

## Что строим

**Встроенная фотогалерея** двигателя: один альбом всех **фото** двигателя (image-подмножество `attachments`; не-картинки остаются в существующей таблице). Сетка превью → крупный просмотр (лайтбокс) с листанием ←/→, множественным выбором и панелью из 6 кнопок над текущим фото.

### 6 кнопок (одиночное фото / группа выбранных — действия идентичны)

| Кнопка | Поведение | Реализация |
|---|---|---|
| **Копировать** | Активное фото → буфер обмена Windows | main: download оригинал → `nativeImage.createFromPath` → `clipboard.writeImage`. ⚠️ Буфер Windows хранит **одно** изображение → в режиме выбора копирует активное; для нескольких — подсказка «используйте Отправить/Собрать». |
| **Удалить** | Удалить с сервера + убрать из `attachments` | Переиспуем существующий flow: `onChange(list без id)` → `files.delete(id)`. Группа — один confirm на все. Соблюдаем queued (pre-approval) ветку. |
| **Выбрать** | Вкл/выкл режим множественного выбора (чекбоксы/подсветка превью); набор выбранных управляет групповыми действиями | renderer-state. |
| **Отправить** | Во внешние сервисы: почта, Telegram, MAX, флешка | **см. «Решение по Отправить» ниже** — на Windows нет API «поделиться» в сторонние десктоп-приложения. |
| **Печать** | Печать фото на принтер | main: build HTML (по 1 фото на A4) из оригиналов → `renderHtmlWindow` → `webContents.print`. |
| **Собрать** | Выбранные фото → один PDF, сохранить (по умолчанию Рабочий стол, спросить путь) | main: build HTML (1 фото/страница) → `printToPDF` → `dialog.showSaveDialog({ defaultPath: desktop/'Фото двигателя <№>.pdf' })` → запись файла. |

### Решение по «Отправить» (нужен OK владельца)

На Windows из Electron **нельзя** программно «закинуть» файл в чужое десктоп-приложение (личный Telegram/MAX/почтовый клиент оператора) — системного share-sheet нет. Универсальный мост — отдать файлы и дать оператору перетащить их. Предлагаю «Отправить» как маленькое меню с достижимыми целями:

1. **На флешку / в папку…** → выбрать каталог (`showOpenDialog openDirectory`) → копировать туда оригиналы. Закрывает «флешку» и «дай мне файлы».
2. **Открыть папку с файлами** → скачать оригиналы во временную папку → `showItemInFolder` → оператор перетаскивает в Telegram/MAX/почту. Это реальный путь для Telegram/MAX (push в чужое приложение невозможен).
3. **Почта…** → `shell.openExternal('mailto:')` открывает почтовый клиент (вложить через mailto нельзя) + reveal файлов для перетаскивания.

**✅ Владелец выбрал полное меню (п.1 + п.2 + п.3).**

## Файлы (минимум новых — предпочитаем правку существующих)

- **NEW** `electron-app/src/renderer/src/ui/components/EnginePhotoGallery.tsx` — лайтбокс: сетка превью + крупный просмотр (←/→), множественный выбор, тулбар 6 кнопок. Превью через `files.previewGet`; крупное — новый `files.originalGet` (оригинал как dataURL, кэш).
- **EDIT** `electron-app/src/main/services/fileService.ts` — добавить: `filesOriginalGet` (оригинал → dataURL), `filesCopyImageToClipboard`, `filesCopyToFolder(ids, dir)`, `filesRevealForShare(ids)`, `photosAssemblePdf(ids, savePath)`, `photosPrint(ids)` (+ локальный `renderHtmlWindow`/`buildPhotosHtml`).
- **EDIT** `electron-app/src/main/ipc/register/files.ts` — IPC-обработчики под существующими гейтами.
- **EDIT** `electron-app/src/preload/index.ts` — bridges в блоке `files` (`originalGet`, `copyImage`, `copyToFolder`, `revealForShare`, `assemblePdf`, `print`).
- **EDIT** `electron-app/src/renderer/src/ui/pages/EngineDetailsPage.tsx` — подключить галерею рядом с `AttachmentsPanel` (фото-подмножество); вход «Открыть галерею» / клик по превью.
- Типы IPC — `shared/src/ipc/types.ts` при необходимости.

## Этапы (PR-flow, отдельные коммиты под гейтами)

1. **main + IPC + preload** — сервисные функции и каналы (clipboard, originalGet, copyToFolder, reveal, assemblePdf, print). Гейты: typecheck/lint/backend-test.
2. **EnginePhotoGallery.tsx** — лайтбокс + сетка + множественный выбор + тулбар; подключение в EngineDetailsPage.
3. **CDP-verify** на verifier-electron: открыть карточку богатого двигателя (прод-снапшот), открыть галерею, прогнать каждую кнопку (Копировать/Печать-в-PDF без диалога/Собрать в temp/Удалить на тестовом фото). ⚠️ Грабля: правки renderer/main — Electron перезапускать (kill+start), HMR отдаёт stale-модуль.
4. **PR** → diff владельцу → squash-merge под зелёными гейтами. Релиз — отдельным `/reliz` (client-only, без миграций).

## Открытые вопросы

- **Подход «Отправить»** (см. выше) — подтвердить или скорректировать цели.
- Группа-Копировать: ограничение буфера Windows (одно изображение) — ОК оставить «копирует активное + подсказка»?
- Печать/Собрать — лэйаут: 1 фото на A4-страницу (вписать с полями), портрет/альбом по соотношению сторон. ОК по умолчанию.
