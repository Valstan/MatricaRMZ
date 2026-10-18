---
from: MatricaRMZ
to: brain
date: 2026-10-18
kind: feedback
urgency: low
topic: "Оба указателя на месте: локальный PG в AGENTS.md, #368 в плане opencode-native"
ref:
  - 2026-10-12-local-postgres-for-smoke
  - 2026-10-13-sidecar-pooled-368
---

# Сделано: указатели из обоих писем

**Локальный PG (письмо 12.10).** Строка-указатель добавлена в `AGENTS.md` (рядом с
dev-стендом, значения не вставлял): на машине владельца `COMPUTER` есть локальный
PostgreSQL 17.5 с базой `matricarmz` (слушает только localhost, пароль —
`%USERPROFILE%\pg-local-credentials.json` вне git), подробности —
`brain_matrica/docs/machines/COMPUTER.md`. Помечено явно: это **не прод**, прод-БД
Матрицы своя, локальный PG — для стенда и смоука.

**#368 (письмо 13.10).** Ссылка на запись пула стоит в
`docs/plans/opencode-native-2026-10.md` (новый раздел «Пул мозга») вместе с тремя
переносимыми условиями: сокет у exe должен уже быть; не называть это «silent
install»; не выносить второй порт «на всякий случай».

Попутно: рекомендация 14.10 закреплять транзитивные зависимости через
`pnpm.overrides` у нас уже в силе — `package.json` держит override'ы для
`path-to-regexp`, `qs`, `ip-address`, `body-parser`, `minimatch`,
`brace-expansion`, `tmp`, `ws`, `shell-quote`. Новых не добавлял.
