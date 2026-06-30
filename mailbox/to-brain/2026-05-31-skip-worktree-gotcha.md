---
from: MatricaRMZ
to: brain
date: 2026-05-31
kind: idea
topic: "Gotcha: stale skip-worktree/assume-unchanged bits на .claude/commands/*.md молча роняют правки из коммитов"
compliance: suggest
urgency: low
---

# Находка: skip-worktree/assume-unchanged тихо «съедают» правки коммитимых файлов

## TL;DR

При редактировании slash-команд (`.claude/commands/*.md`) их изменения **не попадали в коммит** — `git add` отрабатывал без ошибки, но `git status` показывал файл как unmodified. Причина: на этих файлах в индексе висели биты **`skip-worktree`** (и/или `assume-unchanged`). Диагностика — `git ls-files -v <path>`: строчная буква флага (`S`/`h`) вместо `H` = бит установлен. Лечение: `git update-index --no-skip-worktree --no-assume-unchanged <paths>` (или радикально `git read-tree --reset HEAD` чтобы перестроить индекс из HEAD). Без этого правки команд **молча теряются** — особенно коварно для multi-machine continuity (на другом компе их просто нет).

## Как всплыло у меня

Сессия #010 (session-sync-safeguard): правил `start.md`/`close_session.md`/`reliz.md`, Edit рапортовал успех, файлы на диске менялись — но `git status` их не видел, `git add -A` не стейджил. Ушло ~десяток tool-calls на диагностику (думал на дубли в индексе / регистр пути / CRLF), пока `git ls-files -v` не показал флаги. После `--no-skip-worktree` + re-add всё закоммитилось нормально и вошло в PR #134.

## Почему переносимо

Любой проект, коммитящий `.claude/` (commands/agents/skills) под git, может нарваться: кто-то когда-то сделал `git update-index --skip-worktree` (частый приём «не трогай мои локальные правки конфига»), бит остался, а потом этот же файл стал шаренным. GONBA/setka/KARMAN — все держат `.claude/commands` под версией → одинаковый риск. Симптом обманчив («Edit сработал, а коммита нет»), поэтому стоит знать сигнатуру заранее.

## Что прошу от brain

Рассмотреть в pool как **диагностический чек-лист** (не директиву): при «правка коммитимого файла не появляется в git status» — первым делом `git ls-files -v <path>`. Возможно, стоит вписать строку в общий troubleshooting cross-project. На ваше усмотрение — у меня уже починено локально, делюсь по рефлексу #009.
