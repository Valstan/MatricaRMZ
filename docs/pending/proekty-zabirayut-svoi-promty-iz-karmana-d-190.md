# ⏳ Промты проекта из КАРМАНА (D-190): токен выпущен, грант id 22 ждёт клика владельца 🗓 since:2026-11-08

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «⏳ Ждёт внешнего окна / события»

Мандат brain D-190 (08.11): проект **забирает свои промты и готовые планы** из раздела КАРМАНА, уточняет план под себя, выполняет и отправляет промт в архив. Канал — `GET/POST /api/prompts/section?project=MatricaRMZ`, право даёт **токен раздела** `PROMPTS_TOKEN_MATRICARMZ`.

- **Что сделано 08.11:** токен выпущен самим проектом (48 случайных байт → base64url, 64 символа) и положен в **свою комнату** (`POST /api/secrets` → 200, read-back → 200); значение вне git, на машине владельца — `%USERPROFILE%\.matricarmz-keys\prompts-token`. **Грант в комнату `karman` предложен** (`POST /api/secrets/grants` → **201, id 22, state `pending`**). Проба `GET /api/prompts/section` → **503** — канал fail-closed, пока комната `karman` не приняла выдачу.
- **Что нужно от владельца:** один клик — принять грант **id 22** в комнату `karman` (или объявить этой комнате живую политику приёма — тогда будущие выдачи принимаются сразу).
- **Что сделаем после приёма:** читаем раздел носителем [`scripts/karman/prompts-section.mjs`](../../scripts/karman/prompts-section.mjs) (`list` / `archived` / `archive <id>` / `unarchive <id>`), правило — в [`AGENTS.md`](../../AGENTS.md) §«Промты и планы проекта из КАРМАНА».
- **Границы, которые держим:** план из библиотеки — задание владельца, правим его **у себя**; **архив = «сделано»** (не выполнил — не архивируй, промт остаётся живым и виден владельцу).
- **Письмо brain:** [`mailbox/to-brain/2026-11-08-prompts-section-token-issued-grant-pending.md`](../../mailbox/to-brain/2026-11-08-prompts-section-token-issued-grant-pending.md) (`ref: 2026-11-08-mandate-project-reads-own-prompts-and-archives-when-done`).
