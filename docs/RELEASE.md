# Релиз MatricaRMZ (единая версия)

## Версия
Одна версия для всего проекта (клиент, backend, web-admin, shared).
Источник истины: файл `VERSION` в корне репозитория.

Старт новой схемы: **0.5.50**.

Формат: **MAJOR.MINOR.RELEASE**.

- `MAJOR` — несовместимые изменения.
- `MINOR` — заметные изменения без ломаний.
- `RELEASE` — монотонный счётчик релизов.

## Команда “выпусти релиз”

Важно:
- Перед релизом **обязательно** сделать коммит всех изменений.
- Рабочее дерево должно быть чистым.

Команда релиза:
```bash
cd /home/valstan/MatricaRMZ
pnpm release:auto
```

Что делает `pnpm release:auto`:
- поднимает общую версию по `VERSION`,
- синхронизирует версии всех модулей,
- делает релизный коммит и тег `vX.Y.Z`,
- пушит `main` и теги.

## Backend / Web‑admin после релиза

Если релиз затрагивает backend или web-admin, обновляем сервер:
```bash
git pull
pnpm install
pnpm -C shared build
pnpm -C backend-api build
pnpm --filter @matricarmz/web-admin build
sudo systemctl restart matricarmz-backend.service
```

## Обновления клиента (Windows)

Обновления идут через GitHub Releases и скачиваются **дифференциально** (blockmap).
Клиент проверяет обновления при запуске и устанавливает их автоматически.


