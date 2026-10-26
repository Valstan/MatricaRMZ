# 🟡 Авто-мерж проскочил красный `build-apk`: джоб не в required-checks `main` 🗓 since:2026-10-19

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟡 Техдолг»

PR #1379 (P2, уборка следов OpenCode-узла) смержился в 23:45, хотя `build-apk` упал двумя минутами раньше. В required-наборе защиты `main` стоят `check-sync-contract`, `gitleaks`, `lint`, `semgrep`, `test`, `typecheck`, `migrate-and-verify`, `prod-ops-backup` — **`build-apk` там нет**, и авто-мерж его не ждёт. Красный джоб поймал настоящую поломку (android-бандл втянул `node:child_process` через electron-модуль миграций — грабля M155 в `GOTCHAS.md`): гейт сработал, а ворота его не спросили.

**Решение:** добавить `build-apk` в required status checks `main` (Settings → Branches → protection; через API — PUT `.../protection/required_status_checks` с полным списком: метод перезаписывает набор, а не дополняет). Проверка после правки: ветка с заведомо красным android-билдом не должна получать авто-мерж. Пока не сделано — перед мержем PR, трогающих `android-app` или общие main-модули, смотреть `gh pr checks` руками, а не полагаться на авто-мерж.
