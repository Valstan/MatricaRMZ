# Релиз MatricaRMZ

Этот документ описывает только то, что реально происходит сейчас.
Все автоматизируемые шаги перенесены в `pnpm release:auto`.

## Версия
Одна версия для всего проекта (клиент, backend, web-admin, shared).
Источник истины: файл `VERSION` в корне репозитория.

Формат: **MAJOR.MINOR.RELEASE**.
- `MAJOR` — несовместимые изменения.
- `MINOR` — заметные изменения без ломаний.
- `RELEASE` — монотонный счётчик релизов.

## Релиз (1 команда)
```bash
cd /home/valstan/MatricaRMZ
pnpm release:auto
```

### Что делает `pnpm release:auto`
- Коммитит текущее рабочее дерево (если есть изменения).
- Синхронизирует версии пакетов с `VERSION` (или увеличивает `RELEASE`, если тег совпадает).
- Создает релизный коммит и тег `vX.Y.Z`, пушит `main` и теги.
- Если есть изменения в `backend-api`/`web-admin`/`shared` — собирает и перезапускает backend.
- Ждет Windows‑артефакт в GitHub Releases и скачивает **.exe установщик** в `/opt/matricarmz/updates`.
- Проверяет `/updates/status` (если сервис обновлений включен).
- Публикует релиз в ledger **автоматически**, если задан `MATRICA_LEDGER_RELEASE_TOKEN`.

## Что нельзя автоматизировать (и нужно сделать вручную)
1) **Смена MAJOR/MINOR**
   - Обновите `VERSION` вручную, если нужен переход MAJOR/MINOR.
2) **Если GitHub Actions/gh недоступны**
   - Проверьте workflow `release-electron-windows.yml` и артефакты релиза `vX.Y.Z`.
   - При необходимости запустите вручную:
     ```bash
     gh workflow run release-electron-windows.yml --ref vX.Y.Z
     ```
3) **Если нет токена ledger**
   - Публикация в ledger обязательна для автообновлений.
   - Если `MATRICA_LEDGER_RELEASE_TOKEN` не задан, выполните:
     ```bash
     curl -sS -X POST http://127.0.0.1:3001/ledger/releases/publish \
       -H "Content-Type: application/json" \
       -H "Authorization: Bearer <token>" \
       --data '{"version":"X.Y.Z","notes":"short changelog","fileName":"<installer>.exe","sha256":"<hex>","size":12345678}'
     ```
     SHA256:
     ```bash
     sha256sum "<installer>.exe"
     ```

## Имена релизных файлов
- Windows‑установщик — **.exe** (NSIS), имя задается `electron-builder`.
- Скрипт ждёт **любой .exe asset** из GitHub Release. Если .exe несколько, лучше оставить один установщик.
- В релизе обычно есть:
  - `<Product> Setup X.Y.Z.exe`
  - `<Product> Setup X.Y.Z.exe.blockmap`

## Переменные релиз‑скрипта (по необходимости)
- `MATRICA_RELEASE_ASSET_WAIT_MS`
- `MATRICA_RELEASE_ASSET_WAIT_ATTEMPTS`
- `MATRICA_RELEASE_ASSET_POLL_MS`
- `MATRICA_RELEASE_DOWNLOAD_ATTEMPTS`
- `MATRICA_RELEASE_STATUS_WAIT_MS`
- `MATRICA_RELEASE_STATUS_POLL_MS`
- `MATRICA_RELEASE_SKIP_STATUS_WAIT=true` (если сервис обновлений отключен)
- `MATRICA_RELEASE_TRIGGER_WINDOWS_WORKFLOW=true` (если нужен ручной запуск workflow)
- `MATRICA_LEDGER_RELEASE_TOKEN` (публикация релиза в ledger)
- `MATRICA_LEDGER_RELEASE_NOTES` (опционально, notes для ledger)

## Обновления клиента (актуально)
- Источники: **GitHub Releases** и **Yandex.Disk**.
- Клиент проверяет обновления при запуске, скачивает тихо и устанавливает при следующем запуске.
- Перед установкой выполняется проверка по ledger (version/fileName/size/sha256).


