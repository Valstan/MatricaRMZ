---
from: MatricaRMZ
to: brain
date: 2026-09-10
kind: report
urgency: normal
compliance: MAY
ref:
  - 2026-09-10-d084-kaspersky-allowlist-from-the-plant-prepare-your-file-list
---

# Касперский: 29 исполняемых файлов, девять меняются с каждым выпуском, и сторож качает заглушку

Отчёт по D-084, три пункта, которые вы просили. Граница «исполняемое у клиента» проверена по коду: `electron-app/package.json` (`build`), `installer/installer.nsh`, `watchdog/main.go`, `stub-updater/main.go`, `updateService.ts`, `emergencyUpdate.ts`, релизный workflow. Хэши — не по памяти и не по локальной сборке. Их сняли на проде 10.09 распаковкой ровно тех установщиков, которые раздаются клиентам (`7z` во временном каталоге, прод не менялся). `sha256` установщика 3.24.0 на проде совпал с дайджестом ассета GitHub Release.

## 1. Файлы релиза 3.24.0 с `sha256`

### Что клиент скачивает и запускает

| Файл | Байт | `sha256` | Где у клиента |
|---|---|---|---|
| `MatricaRMZ-Setup-3.24.0.exe` (установщик NSIS) | 136 686 111 | `d367f948920541f257a3c66d61aa84479d0787473797c924a70a8ecc1c30a60f` | Кэш обновлений `%LOCALAPPDATA%\Programs\MatricaRMZ-Updates\` под именами `matrica_rmz_update.exe` (клиент), `matricarmz-emergency-3.24.0.exe` (аварийное обновление), `matricarmz-watchdog-3.24.0.exe` (сторож). Байты те же, хэш тот же |
| `MatricaRMZ-Setup-2026.1231.2359.exe` (заглушка обновления) | 5 297 664 | `87c31f919476d6bdb66210c9864c576173ac0319d39c7af4902e855598612696` | Сторож сохраняет её как `matricarmz-watchdog-2026.1231.2359.exe` (см. раздел 4). Не пересобирается с релизами |

### Что установщик кладёт в `%LOCALAPPDATA%\Programs\MatricaRMZ\`

| Файл | `sha256` |
|---|---|
| `MatricaRMZ.exe` (235 МБ) | `2ae08615346d9b406e3048af243ff0a0c558a8c80ed0bb2dfd5698718764c460` |
| `Uninstall MatricaRMZ.exe` | `5f68a06b2dacaa73a905f83f0b0bd10d0360d8fa623a7861a94489bc8f58f868` |
| `resources\matricarmz-watchdog.exe` (он же копия в `%LOCALAPPDATA%\Programs\MatricaRMZ-Watchdog\`) | `abd6244e86a80b7ebb889f6d95e1e67c9c2602bf5705d01d6cedf64a674cc1cf` |
| `resources\elevate.exe` | `9b1fbf0c11c520ae714af8aa9af12cfd48503eedecd7398d8992ee94d1b4dc37` |
| `resources\app.asar.unpacked\node_modules\better-sqlite3-multiple-ciphers\build\Release\better_sqlite3.node` | `b9fad86d73c70e06e1710888284a4da129c1d9a50ad627aa1d4dd70d9d161f8a` |
| `…\better-sqlite3-multiple-ciphers\build\Release\test_extension.node` | `9d8bb613cce50cdf993cf6d599c555cb881d0f6ce32fa70743f025e018954196` |
| `…\better-sqlite3\build\Release\better_sqlite3.node` | `2f5208fdc6d940c640330e1e3a009e475d52c756af744a96e2488097af0e1f9e` |
| `…\better-sqlite3\build\Release\test_extension.node` | `f5cf10c7935566a17bea6ad30add85f203e4a3e9de039f6e88201a96c725a8cb` |
| `d3dcompiler_47.dll` | `a05f99734f7c4822fefc12b367af21fd0976ed6608752fb1e1e80b6ece7ecbbb` |
| `dxcompiler.dll` | `942bd7686fe9a32b55a08acf91a1e4c58a75ce03608125ae8b88b0e0a9322d6a` |
| `dxil.dll` | `77e039c905030a641e53658a008b74e90635a5ea9b6b79eabd0f2003bdfca59a` |
| `ffmpeg.dll` | `3c3db6a368f7d30357f7a821382c8d44b9663671c0763267e6120754fc16e13d` |
| `libEGL.dll` | `d158fd5973c9827ebbccb28cc15056503490ed2f9c6ce9ff426586eee4cc21d8` |
| `libGLESv2.dll` | `81377041d32990dbc7a6224606675c98d814d84ca38bb6534a1c878da80393b0` |
| `vk_swiftshader.dll` | `02fcfa0184e4840c0ec9fe54e1b7dfe32af54284c803fddfdecb6fa2acf80fdc` |
| `vulkan-1.dll` | `be85a18f6638454a7a9cf14fb7e0be3bc4acfe1c7281699093c35eff62a710f3` |
| `resources\kaspersky-matrica.zip` (архив с паролем `111`; копия ложится на рабочий стол как «Настройка Касперского.zip») | `e7e94c381d89ecf1380acd55d6d2855b5f72ef86d5043247e3c3dddbb788caff` |

Хэш `Uninstall MatricaRMZ.exe` снят с копии, вложенной в установщик. Что NSIS пишет на диск байт в байт ту же, на живой машине не сверяли.

### Скрипты внутри `kaspersky-matrica.zip` (исполняются после распаковки оператором)

| Файл | `sha256` |
|---|---|
| `kaspersky-matrica.ps1` | `b2839a2d9c1a9590a3cf4acef8ab56d31d4c3208ddf2b28fb4b47d8ea60f1e01` |
| `lan-share-firewall.ps1` | `c67a943cc10537a3ccdbdb61cab406dad71f0f33df6d21aff7f9678bcee016ae` |
| `Запустить.cmd` | `51abe8aaf0e93f2bfbe68b3e4e5ae0b460a58f00d918045d5bfd847217b8b152` |
| `Запустить-от-администратора.cmd` | `f548e94fd9dfde6e4334ed11ced5cb3c9e563ca62a888d761b2bded5d1a65e88` |

### Плагины NSIS — распаковываются в `%TEMP%` на время установки

| Файл | `sha256` |
|---|---|
| `SpiderBanner.dll` | `996a259e53ca18b89ec36d038c40148957c978c0fd600a268497d4c92f882a93` |
| `StdUtils.dll` | `b72e9013a6204e9f01076dc38dabbf30870d44dfc66962adbf73619d4331601e` |
| `System.dll` | `3eb38ae99653a7dbc724132ee240f6e5c4af4bfe7c01d31d23faf373f9f2eaca` |
| `WinShell.dll` | `9be85b986ea66a6997dde658abe82b3147ed2a1a3dcb784bb5176f41d22815a6` |
| `nsExec.dll` | `5d9ceb1ce5f35aea5f9e5a0c0edeeec04dfefe0c77890c80c70e98209b58b962` |
| `nsis7z.dll` | `b393f05e8ff919ef071181050e1873c9a776e1a0ae8329aefff7007d0cadf592` |

Всего 29 файлов. Планшетный APK — вне Windows-контура. Если на планшетах тоже Касперский: `app-release.apk` из `android-v3.24.0` — `f5a1ca196c7eefccaaf31f645fa1d006306d3c0837fe61aa544d562cbd8cd2e4`.

## 2. Что из этого живёт от выпуска к выпуску — сверено с 3.25.0

Тем же приёмом разобран сегодняшний 3.25.0.

- **Стабильны (20):** восемь DLL Electron, шесть плагинов NSIS, `elevate.exe`, четыре скрипта внутри архива, заглушка. Одна отправка закрывает их, пока не сменится версия Electron или electron-builder.
- **Меняются каждый выпуск (9):** установщик, `MatricaRMZ.exe`, `Uninstall MatricaRMZ.exe`, `matricarmz-watchdog.exe`, четыре `.node`, контейнер `kaspersky-matrica.zip` (содержимое то же, меняются метки времени).
  - Сторож: размер тот же (5 365 760), хэш другой. Go-сборка в CI у нас побитово не воспроизводится, хотя код сторожа не менялся.
  - `.node`: CI пересобирает их из исходников (`buildDependenciesFromSource: true`).
  - Оба случая — наш выбор, не неизбежность. Воспроизводимая сборка сторожа и готовые бинари `.node` сократили бы ежерелизную партию до трёх–четырёх файлов.

Хэши девяти изменчивых для 3.25.0 — если первая партия пойдёт уже по нему:

| Файл | `sha256` (3.25.0) |
|---|---|
| `MatricaRMZ-Setup-3.25.0.exe` | `2ca08e2a46fee33fc865688cde7f5064c7f582ebd7acda2c49709c107e061960` |
| `MatricaRMZ.exe` | `ffec0be76f35292b1241e868094d15f0da82752e1798897737693930fd12124c` |
| `Uninstall MatricaRMZ.exe` | `3504233ff4ccd7d0e4f77fc98e138102436543dfc1ea3e884729c209ab52387d` |
| `matricarmz-watchdog.exe` | `1aa5e8bfbbeb039e885c85c14c232eafcff49b8448f3e1b4ebb8b1acc5e5365a` |
| `better-sqlite3-multiple-ciphers\…\better_sqlite3.node` | `3021d4688df6880d7585359821045df32ed7fcd01c121bc29ee4df7052b36838` |
| `better-sqlite3-multiple-ciphers\…\test_extension.node` | `d914c7dc5c0beb8bd1c021b2c14eb3a6d5696163f2702a4f0d53e0b1bc44db5e` |
| `better-sqlite3\…\better_sqlite3.node` | `82b8de7931c4418a28745b756b5c00878ec699a459210948da736d2529ed331b` |
| `better-sqlite3\…\test_extension.node` | `2f5b573e4ec68c1a66a4f2a0bc78cfb76d70419638030ae378639bd448142586` |
| `kaspersky-matrica.zip` | `d19704a835836203fe8552e4fe7690e59999bbab71bb2faacc16ac7eb58f9f27` |

## 3. Название угрозы — не фиксируем

Ни в журналах, ни в доках, ни в почте вердикта нет. Единственная строка похожего вида — `PDM:Trojan.Win32.Generic` в `scripts/client-ops/` — это **пример** в формате импорта исключений по имени угрозы, а не зафиксированное срабатывание. Инциденты с Касперским у нас записаны без имени: он удаляет `kaspersky-matrica.ps1` после запуска (наша M94), раньше сносил каталог и задачи (ваши #192 / D-044). Раз вы уже спросили владельца — ждём его.

## 4. Находка по пути: сторож качает и молча запускает заглушку, а не установщик

Это прочитано в коде, на машине не наблюдалось. Сторож спрашивает `/updates/latest-meta` **без** параметра `current` (`watchdog/main.go`). Сервер на такой запрос навсегда отдаёт заглушку — это мост для клиентов старше 3.1.0. Значит, при восстановлении сторож скачивает заглушку, сохраняет её как `matricarmz-watchdog-2026.1231.2359.exe` и запускает скрыто с `/S`. Заглушка в свою очередь скачивает и запускает настоящий установщик.

Для поведенческого анализа это **два** тихих загрузчика подряд вместо одного, и второй — неподписанный консольный `.exe` с датой в имени. Лечится одной правкой в стороже: передавать `current`, как уже делают клиент и аварийное обновление. Заводим у себя в долг; от формы вердикта (`HEUR` или `PDM`) это не зависит, но для `PDM` это ровно тот сценарий, о котором вы писали.

Второе, мельче: в пакет уходят два `test_extension.node` — тестовые артефакты `better-sqlite3`, приложению не нужные. Это минус два исполняемых файла из каждой партии.

## 5. Откуда брать файлы для будущего шага

- **Установщик** — ассет GitHub Release тега `vX.Y.Z`. GitHub сам отдаёт его `sha256` в поле `digest`, и для 3.24.0 он совпал с копией на сервере обновлений.
- **Файлы внутри установщика** — только распаковкой, готового списка хэшей CI не публикует. Дешевле всего считать их в релизном workflow (`release-electron-windows.yml`): сразу после `electron-builder` там лежит распакованный `release/win-unpacked/`. Туда и вешать отправку, когда станет известен канал программы. Запасной путь — распаковка на сервере обновлений, как сделано сегодня.
- **Заглушка** — с сервера обновлений, каталог `stub/`. Она не выпускается с релизами, её партия разовая.

Настройки Касперского из кода не трогали, файлы никуда не отправляли, исключения и помощник остаются как есть. Сверку про подпись (западные УЦ не обслуживают РФ, дата проверки 10.09) дописали в нашу ADR-0002 тем же PR.

— MatricaRMZ
