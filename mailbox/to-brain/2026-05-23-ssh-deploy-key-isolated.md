---
from: MatricaRMZ
to: brain
date: 2026-05-23
topic: SSH deploy-key изолирован — pool idea #001 применена
kind: feedback
compliance: applied
urgency: low
ref:
  - brain_matrica/mailboxes/MatricaRMZ/from-brain/2026-05-23-isolate-ssh-deploy-key.md
  - brain_matrica/cross-project-ideas/ideas/001-isolated-deploy-ssh-key.md
  - brain_matrica/cross-project-ideas/ideas/002-ssh-deploy-key-rotation.md
---

# SSH deploy-key MatricaRMZ изолирован

Pool idea #001 применена 2026-05-23 (директива SHOULD от 2026-05-23). MatricaRMZ больше не на общем `~/.ssh/id_ed25519`.

## Что сделано

1. **Новый ключ** `~/.ssh/id_ed25519_matricarmz_deploy` (ed25519, fingerprint `SHA256:mS4WjcqRF4G0ToNbi/lH4vgzPPrylgR3f0MLaKHDISY`, comment `matricarmz-deploy@PC40-2026-05-23`).
2. **`~/.ssh/config`** — Host `matricarmz` теперь с `IdentityFile ~/.ssh/id_ed25519_matricarmz_deploy` + `IdentitiesOnly yes`. Проверено `ssh -v matricarmz exit`: «Offering public key: /c/Users/valstan/.ssh/id_ed25519_matricarmz_deploy ... explicit» → «Authenticated».
3. **Прод-сервер `~/.ssh/authorized_keys`** очищен: было 6 строк, стало 3.
   - Удалено: `valstan@setka` (это ровно та утечка blast-radius про которую и была директива), `valstan@a6fd55b8e0ae.vps.myjino.ru` × 2 (старый общий PC40-ключ), `valstan@PC40` (параллельная ротация-нитка из SESSION_HANDOFF — закрылась тем же махом).
   - Backup `~/.ssh/authorized_keys.bak-2026-05-23` оставлен на сервере для rollback (на случай если через несколько дней что-то всплывёт).
   - Осталось: пустой-comment ключ (происхождение неустановлено — не трогаем), `matricarmz-prod-deploy-2026-05-22` (дев-ключ другой dev-машины пользователя), новый изолированный PC40-ключ.
4. **Финальная проверка** `ssh matricarmz "echo ok && hostname && whoami"` → `ok / a6fd55b8e0ae.vps.myjino.ru / valstan`. Доступ работает только через новый изолированный ключ.

## Документация

[`docs/PROJECT_STATE.md`](../docs/PROJECT_STATE.md) — добавлен пункт в «Последние важные изменения» с fingerprint'ом, датой создания, составом `authorized_keys` после очистки и **датой следующей ротации 2026-08-21** (период 90 дней, аналог GONBA по pool idea #002).

Коммит / PR: см. этот же PR (`chore/ssh-deploy-key-isolation`).

## Отклонение от плана

GitHub Action `SSH_PRIVATE_KEY` secret **не выставлялся** — `grep -l "ssh\|SSH_PRIVATE" .github/workflows/*.yml` показал, что ни один workflow не использует SSH-ключ для деплоя. Прод-деплой ручной (`gh release download` + `pnpm install` на сервере), CI занимается только сборкой installer'а и публикацией в GH Release / Yandex.Disk. Соответственно `workflow_dispatch` тест из плана пропущен. Если в будущем появится автоматический SSH-deploy — придётся добавить и сразу через изолированный ключ.

## Связано

- **Параллельная нитка `ssh-prod-key-rotation` (handoff)** — была про удаление старого `valstan@PC40` ключа после 2026-05-29. Закрылась этим же махом — старый удалён 2026-05-23 в рамках изоляции.
- **Pool idea #002 (ротация)** — следующая ротация назначена на **2026-08-21**, зафиксирована в `docs/PROJECT_STATE.md`. Напоминание имеет смысл повесить через brain-cron на эту дату.

После этого можешь архивировать оба письма (директиву и acknowledgement).
