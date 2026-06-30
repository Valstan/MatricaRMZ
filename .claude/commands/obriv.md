---
description: Восстановление после обрыва связи — самопроверка целостности работы и продолжение
---

Был **обрыв связи/сессии**. Принцип — **идемпотентность**: восстанови картину из «земли» (git/gh/файлы), **не переделывай вслепую**, не задвой коммит/PR. Не начинай новое, пока не подтвердил, что прерванная нить цела.

## 1. Один диагностик-вызов (вся картина за раз)

```bash
git fetch origin --quiet 2>&1 | tail -2
echo "branch: $(git branch --show-current)"; git status -sb
echo "--- origin...HEAD (behind ahead) ---"; git rev-list --left-right --count origin/main...HEAD
echo "--- log ---"; git log --oneline -6
echo "--- stash ---"; git stash list
echo "--- reflog ---"; git reflog -5
echo "--- edits (исходник как Bin → §3 битая запись) ---"; git diff --stat; git diff --cached --stat
```

Читай так: ветка; дерево (чисто / N правок / staged); `behind>0`→нужен pull, `ahead>0`→есть незапушенные коммиты; reflog — последнее реальное действие перед обрывом; любой код-файл показан **`Bin`** → §3.

## 2. Развилка (выбери дешёвый путь)

- **Дерево чистое, на `main`, reflog оканчивается на fetch/pull/checkout** → ничего не потеряно. Перечитай [`SESSION_HANDOFF.md`](../../docs/SESSION_HANDOFF.md) «Следующий шаг» и **продолжай нить**. Дальше §3–4 не нужны — стоп здесь (частый случай).
- **Feature-ветка / незакоммиченные правки / `ahead>0`** → работа была в полёте → §3.

## 3. Реконсиляция прерванной работы

- Незакоммиченные правки — завершённые или оборванные на полпути? **Не доверяй памяти — перечитай (Read)** участок файла, который правил последним.
- Код-файл как `Bin` в §1 = битая запись (NUL / UTF-16 / BOM; Windows `Out-File`/`Set-Content` по умолчанию пишут UTF-16 — всегда `-Encoding utf8`). Грабля харнесса [G21](../../../brain_matrica/cross-project-ideas/GOTCHAS.md). Вычистить NUL → пересохранить UTF-8:
  ```bash
  node -e "const fs=require('fs'),f=process.argv[1],b=fs.readFileSync(f),n=[...b].filter(x=>x===0).length;console.log(f,'NUL',n);if(n)fs.writeFileSync(f,Buffer.from([...b].filter(x=>x!==0)))" '<путь>'
  ```
- `ahead>0` — коммит уже лёг, **не пересоздавай**; запушишь, когда нить дойдёт до пуша.
- PR: `gh pr list --head "$(git branch --show-current)"` — уже есть? **Не задвой** (PR-only flow, [ADR-0002](../../../brain_matrica/adr/0002-pr-only-flow-no-direct-push.md)).
- Фоновые задачи (dev-backend `:3001`, electron) — логи/PID в `.verifier-electron/`; снять прежний инстанс: `.\.claude\skills\verifier-electron\scripts\stop.ps1` (не плодить дубли на портах).

## 4. Трогался код → перепрогони гейты (зеркало CI)

`shared` и `ledger` собираются **первыми**, иначе typecheck зависимых падает:
```bash
corepack pnpm --filter @matricarmz/shared build
corepack pnpm --filter @matricarmz/ledger build
corepack pnpm -r typecheck && corepack pnpm -r lint
```
backend-логика/маршруты → `corepack pnpm --filter @matricarmz/backend-api test`. UI в `electron-app/` → CDP-smoke ([verifier-electron SKILL.md](../skills/verifier-electron/SKILL.md)). Правка в `shared/` → пересобрать его перед перезапуском стека (hot-reload нет).

## 5. Доложи и продолжи

`Обрыв: ветка <X>, HEAD <Y>, дерево <чисто/N правок>, origin <±N>, PR #<N> <состояние>. Потеряно: <ничего/…>. Продолжаю: <шаг>.` — и **возобнови работу с места остановки**.
