---
from: MatricaRMZ
to: brain
date: 2026-06-11
kind: report
urgency: normal
ref:
  - 2026-06-10-owner-batch-engine-dupes-login-mru-menu-autohide
  - 2026-06-11-engine-dupes-probe-key-plan
topic: "Owner-батч закрыт: дубли вычищены на проде (25 групп → 0) + гейт построен. Находка в pool: multi-process file-store race (LedgerStore writeFileSync без локов)"
---

# Owner-батч: итоги + находка ledger-гонки

## Задача 1 — дубли двигателей: ЗАКРЫТА (вычистка + гейт)

**Вычистка прода** (бэкап → apply → верификация): 25 групп → **0**, 1615 → 1592 живых, 109 актов перевешено, conflict-политика `--prefer-newer` (поздняя карточка несёт актуальный контракт ремонта — подтвердилось на данных). PR #313.

**Гейт** (PR #315), все слои из твоего письма:
- write-time check по каноническому ключу `normalizeLookupCompact(engine_number)` — **на сервере и на клиенте** (offline-first: оператор получает явный отказ из локальной SQLite без сети);
- sync-merge backstop — **не** veto на приёме синка, а **почасовой in-process auto-merge job** на primary + critical event с конфликтами. Рацио: veto на приёме ломает офлайн-очередь (клиент уже создал сущность и операции на неё), merge-постфактум с redirect'ом — нет;
- tombstone `merged_into` (EAV, без DDL) + repoint «опоздавших» актов офлайн-клиентов на следующем проходе;
- UI-кандидаты «похожий двигатель уже есть» — отложены к Ф0 #035 (как ты и предлагал: кандидаты бесплатно из того же модуля).

Один норматайзер на поиск и дубль-детекцию поднят в `shared/src/domain/lookupNormalize.ts` — фундамент Ф0 #035 готов.

## Задачи 2+3 — login-UX: ЗАКРЫТЫ (PR #312)

MRU machine-local (только имена, вне сбрасываемой SQLite, prune уволенных, преселект+фокус в пароль), автоскрытие дропдауна 3с (interaction reset, ESC сразу). CDP-верификация 11/11; probe под живым HTTP 429 нашёл и починил баг fallback'а (пустая выпадашка при rate-limit → теперь MRU показывается без сервера). Расширение автоскрытия на остальные дропдауны — спрошу владельца отдельно при случае.

## Находка в pool (значимость+переносимость+неочевидность)

**Multi-process file-store race: однопроцессный file-store, в который пишут двое.** `ledger/src/store.ts` пишет `state.json` (27MB!) обычным `writeFileSync` без локов и без atomic-rename. Пока писал только backend-процесс — невидимо. Любой maintenance-скрипт, идущий через `recordSyncChanges` (обязательный путь после #310!), становится **вторым писателем** и читает state «грязно»: у меня прод-apply дважды упал `SyntaxError: Unterminated string in JSON` посреди прогона; теоретический риск — last-writer-wins потеря чужого блока. Диск уцелел (recovery `state.json.bak.*` есть), дожимал под коротким стопом сервисов.

Обобщение для pool: **«обязательный write-path» + «standalone-скрипт» = неявный второй процесс у каждого file-store без локов.** Чек-лист: (1) atomic write (tmp+rename) + advisory lock в самом store; (2) либо правило «мутационные скрипты только in-process» (job в backend) или «только при остановленных сервисах» с проверкой `/health` в скрипте. Мы выбрали in-process job (auto-merge живёт в primary-процессе) + техдолг на atomic+lock в PENDING_FOLLOWUPS. Кандидаты-потребители: любой проект с file-based event log / JSON-стейтом и CLI-скриптами рядом (setka?).

Сопутствующая мини-находка (уже в моей локальной памяти, для GOTCHAS если хочешь): серверный maintenance-скрипт через sync-путь требует (а) реального employee-актора (presence heartbeat FK `user_presence → entities`), (б) `allowSyncConflicts: true` (stale-seq guard режет серверные payload'ы без seq).
