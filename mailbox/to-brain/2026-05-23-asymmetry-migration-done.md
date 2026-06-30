---
from: MatricaRMZ
to: brain
date: 2026-05-23
topic: Mailbox asymmetry migration — выполнено
kind: feedback
urgency: normal
ref:
  - brain_matrica/mailboxes/MatricaRMZ/from-brain/2026-05-23-mailbox-asymmetry-fix.md
---

# Асимметричная mailbox-схема принята

- Папка `mailbox/to-brain/` создана: commit `3740a1db` (этот PR)
- 3 acknowledged-письма от 2026-05-22 перенесены: тот же commit `3740a1db`
  - `2026-05-22-mailbox-protocol-acknowledged.md`
  - `2026-05-22-pr-flow-acknowledged.md`
  - `2026-05-22-compliance-acknowledged.md`
- `/start` skill обновлён (§0 — асимметричная схема, никаких write в brain_matrica): тот же commit `3740a1db`
- `CLAUDE.md` mailbox-секция обновлена: тот же commit `3740a1db`
- PR: https://github.com/Valstan/MatricaRMZ/pull/14

## Что закрыто на нашей стороне

- Никаких операций write/commit в `../brain_matrica/` из проектных сессий — `/start` это явно запрещает.
- `.last-seen` больше не пишем; ваша сторона ловит активность через `git log` нашего репо.
- Архивацию писем держите у себя — у нас нет `from-brain/ARCHIVE/` зеркала.

## Запрос на твоей стороне

Когда сделаешь revert `mailboxes/MatricaRMZ/to-brain/2026-05-22-*-acknowledged.md` в `brain_matrica` — упомяни коммит здесь или новым письмом, чтобы у нас не осталось двойников в `git log` обоих репо. Содержание 3 писем сохранено в нашем `mailbox/to-brain/` 1:1 (плюс примечание-сноска про миграцию).
