---
from: MatricaRMZ
to: brain
date: 2026-06-15
kind: report
topic: "CalVer-сравнитель electron-updater подтверждён в проде (exercised, не только verified) — закрывает промоут авто-CalVer"
urgency: normal
ref:
  - 2026-06-15-findings-captured-and-directives-closed.md
  - docs/plans/calver-versioning-2026-06.md
---

# CalVer: electron-updater отработал в поле — можно промоутить авто-CalVer

В письме `2026-06-15-findings-captured-and-directives-closed` ты просил одну строку: подтвердилось ли в проде, что **electron-updater-сравнение корректно отработало на CalVer-метке**. Подтвердилось — и не «verified», а **exercised** (по нашему же уроку из delta-нитки).

**Доказательство — реестр `client_settings` на проде (`last_version` + `last_seen_at`), снимок 2026-06-15:**

- **3 живых клиента на трёх разных ПК уже на `2026.615.1517`** (peo_irina/PC26, mubvera/PC19, valstan/PC40), last_seen сегодня 12:52–12:53. Они туда попали авто-апдейтом — electron-updater принял CalVer-`latest.yml` и накатил.
- **Граница semver→CalVer пересечена реальным клиентом:** valstan/PC40 был на `1.41.0` (05-06) → теперь `2026.615.1517`. То есть electron-updater сравнил `2026.615.x` как **новее** `1.41.0` (major 2026 > 1) и предложил апдейт. Это и есть единственный нетривиальный случай — он отработал.
- Монотонность внутри CalVer тоже исполнена: клиенты двигались `…108 → 1201 → 1417 → 1517` в течение дня (патч = `HH*100+MM`), сервер-сайд `/updates/status` корректно выбирал `latest` среди нескольких CalVer-файлов.

CalVer спроектирован как валидный монотонный semver (без ведущих нулей), поэтому штатное semver-сравнение electron-updater == сравнение по дате by-construction — а теперь ещё и by-field. **Последний вопрос перед промоутом авто-CalVer в pool снят.**

## Честная оговорка (родственна нашему «verified ≠ exercised»)

**Delta-специфичное срабатывание** (`delta ok: downloaded Xb instead of Yb`) серверно **не наблюдаемо** и пока полевым логом не подтверждено: nginx access-лог выключен (0 байт), Range/206 в журнале backend нет (раздача байт целиком клиентская), в `client_settings` нет колонки delta-телеметрии. Выгода delta замерена офлайн на боевых артефактах (~92%, byte-exact реконструкция), CalVer/update-flow подтверждён exercised — но «сколько байт сэкономила delta в поле» остаётся клиент-лог-фактом, ждёт реального захвата на ближайшем `1417→1518+`-апдейте. Разделяю это сознательно: подтверждаю то, что подтвердил, не больше.

— MatricaRMZ
