---
from: MatricaRMZ
to: brain
date: 2026-07-15
kind: report
topic: ACK — автономный /reliz + fusion с close_session + slim /close_session + allowlist + /start §5.5 применены
compliance: MUST
urgency: normal
ref: 2026-07-15-reliz-autonomous-close-fusion
---

## ACK: мандат применён (пп.1–5)

Директива `2026-07-15-reliz-autonomous-close-fusion` (mandate, high) выполнена в сессии MatricaRMZ 2026-07-15 по явному OK владельца. Правки только md-файлы + settings.json, кода не касается.

1. **`.claude/commands/reliz.md` — переписан на автономный режим.** Убраны все промежуточные подтверждения: список коммитов → в финальный отчёт (не вопрос); текст `RELEASE_WELCOME_HISTORY` составляется самим из коммитов (+ обязательный новый epigraph); diff релизного PR не показывается — авто-мерж на зелёных гейтах (постулат 30); прод-деплой (pull/install/build/аддитивные миграции/артефакты/ledger-publish/restart/health) — авто подряд; ожидание Action через `gh run watch`. **Единственный гейт — #025** (деструктивная миграция/backfill без revert: DROP/DELETE/TRUNCATE/lossy UPDATE); аддитивные (CREATE/ADD COLUMN/индексы) катятся авто.
2. **`reliz.md` — fusion с закрытием сессии.** Closeout-доки (SESSION_HANDOFF / PENDING / COMPLETED / PROGRAM_EFFECTS / to-brain по фильтру #009) кладутся в **сам релизный PR** до тега; после health-check — `git pull` + **один** прогон sync-гейта + финальный отчёт = сессия закрыта. Отдельный handoff-PR не создаётся, `/close_session` после `/reliz` не вызывается.
3. **`.claude/commands/close_session.md` — разгружен.** Добавлена шапка про быстрый путь (docs-only → один PR, auto-merge, один sync-гейт). Усилен запрет build/typecheck («и не на всякий случай проверить сборку»). §3 (merge PR) и §4 (чистка веток) — один вызов `gh pr list`/`git branch`, работа только если непусто, без повторных сканов. Sync-гейт §9.5 — один прогон на состояние, не циклом.
4. **`.claude/settings.json` — allowlist расширен** (валиден): `ssh matricarmz *`, `scp * matricarmz:*`, `gh run watch *`, `gh release view *`, `git tag *`. `deny` (force-push, push в main) и `autoMode.soft_deny` (#025) — не тронуты.
5. **`.claude/commands/start.md` §5.5 — вопрос про прод-probe убран.** Дефолт «не дёргать прод»; probe только по явной просьбе владельца. Третий вариант («полный SSH на сессию») удалён — не нужен после п.4.

Изменения уедут PR'ом в этой же сессии. Следующий `/reliz` должен пройти от команды до закрытой сессии без вопросов владельцу (кроме #025).
