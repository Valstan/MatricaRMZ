# Pending Followups — только открытое

Открытые задачи, техдолги, отложенные решения. Точка возврата для продолжения из любой сессии / с любого компа.

> **Раскладка (D-097, [ADR-0013](../../brain_matrica/adr/0013-memory-layout-index-plus-chunk-files.md)):** это **индекс**: календарь дат и строка на каждый открытый пункт. Текст пункта — отдельным файлом `pending/<slug>.md`; читай строку индекса, а файл — только по найденной ссылке. Заголовок, ставший ссылкой, значит «у этого раздела есть свой файл» (преамбула или единственный пункт).
>
> **Календарь дат живёт только здесь** («одна дверь для дат», #152): сроки не переносим ни в файлы пунктов, ни в `SESSION_HANDOFF.md`.
>
> **Новый пункт:** файл `pending/<slug>.md` + строка в индексе. **Закрытый — не вычёркиваем, а удаляем**: одна строка в [`COMPLETED.md`](COMPLETED.md) (`/close_session` §7).
>
> Потолок индекса — **50 КБ**, его держит сторож `docsMemoryLayout.guard.test.ts`. Упёрлись — сокращай формулировки и отправляй закрытое в `COMPLETED.md`, а не поднимай потолок.
>
> _Разрезан по D-097 2026-10-26 ([план](plans/memory-index-plus-chunks-2026-09.md)); до этого — один файл на 400 КБ._

---

## Правила ведения

- Добавлять сюда, когда что-то **отложено / техдолг / вернуться позже**. Приоритет: 🔴 блокер → ⏳ ждёт внешнего окна → 🟡 техдолг → 🟢 план/идея.
- **При закрытии — НЕ оставлять ✅-запись здесь:** удалить пункт и перенести 1 строкой в [`COMPLETED.md`](COMPLETED.md) (делает `/close_session` §7).
- **Метки старения** ([ADR-0004](../mailbox/to-brain/2026-06-09-deferred-backlog-aging-applied.md)): к открытому пункту — `🗓 since:YYYY-MM-DD`. `/start` всплывает пункты старше ~30 дней. Externally-blocked метку не несут (ждут события, не «забыты»).

> _Сверено и вычищено 2026-07-12 (сессия backlog-reconciliation): удалены ✅-стены уже отгруженного (owner-batch 2026-07-10 A→H, черновики 3d, товары/услуги deferred-create, прогноз Фаза 3b, security H1/H8/ротация ключей и пр.) — они в COMPLETED/git. Оставлено только реально открытое._

---

## 📅 Календарь ротаций и дедлайнов

Единственное место, где живут даты. Раньше кочевали в «Не забыть» `SESSION_HANDOFF.md` (ротация SSH — 58 повторов подряд, ledger-токен — 47): sticky-note не место для календаря, он перезаписывается каждой сессией.

| Срок | Что | Где подробности |
|---|---|---|
| **~2026-10-25 03:00** | Первый реальный вопрос Ииваныча после суточного сброса free-квоты: `answer_source=engine` → контур A жив через туннель; `429` → пул выходов подписки выеден | [Баланс DeepSeek](pending/balans-deepseek-u-prod-dvizhka-na-nule-operator-ne.md) |
| **~2026-07-29** | ✅ 28.07 проверено: из 25 слотов `force_full_pull` не забрали 15 (машины-призраки и выключенные, вреда не несут). Осталось: 5 старых машин — переустановка владельцем | [де-дупликация](pending/de-duplikatsiya-directory-parts-erp-nomenclature.md) |
| **~2026-07-30** | ✅ 30.07 перепроверено: живых с логином 10; PC71/PC49/PC14 — призраки, исчезли; PC18 обновляется сам; застрявшая осталась одна — PC20 (2026.628.2326, тишина с 16.07), нужна ручная переустановка | [PC20](pending/zastryavshee-avtoobnovlenie-ostalas-odna-mashina-pc20.md) |
| **~2026-08-04** | Прогон deadcode-дельты (knip) | [deadcode-сканер](pending/deadcode-skaner-mesyachnaya-delta-standing.md) |
| **≤2026-09-24** | Ротировать ledger release-token (ротирован 2026-08-28 при отзыве JWT-секрета, exp 2026-09-27) | [ledger release-token](pending/ledger-release-token-protukhaet-2026-10-28-rotirovan.md) |
| **~2026-08-10** | Проверить, что парк обновился до ≥ v2026.808.1830 → затем ретро-скрипты контрактов | [слоты контракта](pending/khvosty-nitki-sloty-kontrakta-pechat-naryadov.md) |
| **~август** | Снести прод бэкап-таблицы `*_bak_20260717` (без sync-колонок, guard молчит; `*_bak_norms20260717` снесены 2026-07-25 по ок владельца) — ⚠️ прод-мутация, требует подтверждения владельца в том же ходе | — |
| **≤2026-11-26** | Ротация SSH-ключа прода `PC79` (выпущен 2026-08-28); ключ `RMZ4VAL` от 2026-06-02 просрочен — за своей машиной | `PROJECT_STATE.md` §SSH |
| **Q3 2026 (авг–сен)** | Квартальный стратегический self-review → письмо в `to-brain` | [deadcode-сканер](pending/deadcode-skaner-mesyachnaya-delta-standing.md) |
| **2026-10-01** | Мозгу строкой: три места `grep -q` под `pipefail` переписаны? (G355/G322). **Ответ готов заранее:** три в `scripts/prod-ops/` переписаны 16.09 (PR #942, v3.36.0), 4-е найдено 18.09 в `deploy/systemd/install.sh:60` и закрыто тем же PR, что и это письмо | закрыт 18.09 — [COMPLETED.md](COMPLETED.md) §Инфра |
| **2026-10-02** | Мандат brain **D-096**, пять строк по дешёвому: где собирается прод-бэкенд (#324) · `default_server` + чужой Host (#251) · заголовки трёх ассетов прода (#250) · чисто ли в логах CI (#223) · три правила в каноне (#166/#125/#152). **Отправлено досрочно 18.09** письмом `2026-09-18-d096-five-cheap-lines-early-and-four-defects-the-lines-uncovered` | `mailbox/to-brain/`, письмо-мандат `2026-09-18-d096-ten-pool-ideas-go-to-work-your-slice-and-three-dates` |
| **2026-10-02** | Мандат brain **D-097** (ADR-0013, одна память на экосистему), ack `report` тремя строками: сколько записей `docs/GOTCHAS.md` переносимы и ушли письмом / стали указателями · `brain_find.py` в каноне (да/дата) · локальные файлы памяти > 50 КБ и план раскладки. **Отправлено досрочно 21.09** письмом `2026-09-21-d097-three-lines-early-three-registries-over-the-cap-and-a-layout-plan`; первая раскладка по плану — `docs/GOTCHAS.md` → индекс + `docs/gotchas/M<N>.md` | план [`plans/memory-index-plus-chunks-2026-09.md`](plans/memory-index-plus-chunks-2026-09.md), письмо-мандат `2026-09-18-d097-one-memory-for-the-ecosystem-read-by-index-write-by-mail` |
| **≤2026-11-08** | **Раскладка реестров > 50 КБ** по плану D-097. ✅ **Фаза 1 (26.10):** `docs/GOTCHAS.md` 522 КБ / 178 записей → индекс **41 КБ** + `docs/gotchas/M<N>.md` (178 файлов, 2.7 КБ в среднем), сторож `docsMemoryLayout.guard.test.ts` держит потолок 50 КБ и целостность ссылок «индекс ↔ файл». ✅ **Фаза 2 (26.10):** `docs/PENDING_FOLLOWUPS.md` 383 КБ → индекс **40 КБ** (календарь дат остался в нём) + `docs/pending/<slug>.md` (132 файла); тем же сторожем проверяется и он. Осталась **фаза 3** (`COMPLETED`, 496 КБ) — не горит. Живых анкоров `GOTCHAS.md#m<N>` в репо нет (проверено 26.10: единственный — в закрытом письме brain от 22.07, его не переписываем) | план [`plans/memory-index-plus-chunks-2026-09.md`](plans/memory-index-plus-chunks-2026-09.md) |
| **2026-10-16** | ✅ **Ack `line` (три строки) отдан досрочно 21.09** письмом `2026-09-21-three-lines-early-open-redirect-closed-rollback-rehearsed-failed-ci-log-read`. Остаток строки — сделанное по D-096. Мандат **D-096**, сделанное: `tsc` ушёл с прод-бокса (#324) · `immutable` с хэшем в пути (#250) · таблица путей записи и прав (#015) **по всем дверям** (REST, импортёры, cron — не только ledger submit; уточнение brain 18.09) · `web-admin/dist` в артефакт (✅ 21.09). Что не успели — **дата, а не молчание** (#152). **Плюс ack `line` на письмо brain `2026-09-18-six-letters-pooled-…` — три строки:** open redirect в nginx закрыт (✅ 21.09: `Location` на литеральный хост, G371) · откат выката прогнан при приёмке (✅ 21.09: команда `rollback`, репетиция на проде `snapshot` → `rollback`, оба инстанса 3.43.0) · лог **упавшего** CI-прогона просмотрен (✅ 21.09: четыре красных прогона 14–17.09 — typecheck, test, lint, gitleaks; ни IP, ни хостов, ни ключей, ни токенов; `ssh` — служебные строки `actions/checkout`, `/home` — только `/home/runner`) | [долги D-096](pending/dolgi-vskrytye-razborom-mandata-d-096-18-09.md) |
| **2026-10-16** | ✅ **Строка «комната КАРМАНа `matricarmz`» в канон закрыта 30.09** — мандат brain D-102, `ack: line` от 30.09 (письмо `2026-09-30-pool-digest-314-342-d102-room-line`). Строка добавлена в `AGENTS.md` §Prod server, список ключей — в `docs/OPERATIONS.md` §8а; **факты перепроверены вживую с бокса перед написанием** (по указу brain: шаблон — форма, а не утверждение): токен `SECRETS_TOKEN` и адрес `SECRETS_VAULT_URL` в `/etc/matricarmz/matricarmz.env`, комната отдаёт ровно 8 ключей из списка, токен бокса `canWrite: false` | §«Комната КАРМАНа» в `OPERATIONS.md` §8а, `AGENTS.md` §Prod server |
| **2026-10-03** | Перемер роста диска прод-бокса. **Точка отсчёта обновлена 30.09** после уборок: база **1532 МБ**, диск 64%, свободно 3.4 ГБ (было 5.8 ГБ занято / 62% на 22.09 — то есть после чистки `operations.meta_json` (−119 МБ) и сноса 271 дубля объём всё равно вырос: журнал выкатов, бэкапы, откатные копии `dist`) | §Техдолг, `SESSION_HANDOFF` §Не забыть |
| **2026-10-30** | Мандат **D-096**, состязательный security-аудит (#057) по очереди из таблицы мандата; отчёт **обязан печатать покрытие** (#293) — сейчас не печатает | [веерное ревью](pending/veernoe-revyu-ne-pechataet-pokrytie-ideya-293.md) |
| **после релиза с #1454** | Пересчёт ложных «Возвратов» в этапах на проде: `stages:recount-passes` (сначала dry-run, `--apply` — только после ОК владельца на список) | [ложные «Возвраты»](pending/lozhnye-vozvraty-v-etapakh-remonta-na-prode-pereschet.md) |
| **2026-11-30** | Мандат **D-096**, второй состязательный security-аудит (#057) — там же требование покрытия | там же |
| **раз в ~2 недели (с 2026-09-01)** | Сессия «проверка перекосов»: после структурных изменений (схема, миграции EAV→erp_*) сверять отчёты/модули на рассинхрон источников данных (пункт 14 пакета владельца 19.08; образец находки — мёртвый `engine_movements`). **Первый прогон — 2026-09-03**, результат в §«Перекосы источников» ниже; следующий — после R4b | план `owner-batch-2026-08-19b` |
| **1-е число месяца (с 2026-11-01)** | **Завод-контур без владельца.** Плановый проход: разобрать `docs/zavod/inbox/` (надиктовки → идеи в `INDEX`), сверить `INDEX` с последними ~30 записями `PROGRAM_EFFECTS` (что уже 💻), принести владельцу 2–3 вопроса и задачи. Триггер — дата, а не чей-то заход в `/zavod` | `.claude/commands/zavod.md` §2а, AGENTS.md §Два режима |

---

## 🟡 Техдолг и отложенное

- [🟡 Выкат прошёл, а скрипт говорит «nginx не ответил» и выходит с кодом 1 — одиночная проверка без повтора 🗓 since:2026-10-29](pending/vykat-proshel-a-skript-govorit-nginx-ne-otvetil.md)
- [🟡 Pull может затереть локальную правку карточки: сервер не говорит, какую строку отклонил по LWW 🗓 since:2026-10-20](pending/pull-mozhet-zateret-lokalnuyu-pravku-kartochki-server.md)
- [Диск прод-бокса заполняют фото с камеры; шифрованный бэкап молча падал 20 ночей 🗓 since:2026-09-03](pending/disk-prod-boksa-zapolnyayut-foto-s-kamery-shifrovannyy.md)
- [🟢 Опрос Telegram-бота конфликтует сам с собой: 409 закрыты, проход загнан внутрь тика 🗓 since:2026-09-06](pending/opros-telegram-bota-konfliktuet-sam-s-soboy-409-zakryty.md)
- [🟡 Долги, вскрытые аудитом Telegram-каналов 06.09 🗓 since:2026-09-06](pending/dolgi-vskrytye-auditom-telegram-kanalov-06-09.md)
- [🟡 Сеть VPS рвётся круглосуточно: Telegram, клиенты и ssh — один и тот же путь 🗓 since:2026-09-09](pending/set-vps-rvetsya-kruglosutochno-telegram-klienty-i-ssh.md)
- [🟡 Yandex Disk API лихорадит: зеркало 3.75.0 без blockmap 🗓 since:2026-10-13](pending/yandex-disk-api-likhoradit-zerkalo-3-75-0-bez-blockmap.md)
- [🟡 Торрент-раздача не имеет потребителя: аппарат работает сам на себя — решение владельца 🗓 since:2026-09-06](pending/torrent-razdacha-ne-imeet-potrebitelya-apparat-rabotaet.md)
- [🟡 Два разошедшихся прод-env: сервисы и ops-скрипты читают разные файлы 🗓 since:2026-09-03](pending/dva-razoshedshikhsya-prod-env-servisy-i-ops-skripty.md)
- [🔴 Закрытые наряды показывались мимо вкладки «Наряды» — закрыто 2026-09-03 🗓 since:2026-09-03](pending/zakrytye-naryady-pokazyvalis-mimo-vkladki-naryady.md)
- [🟡 Перекосы источников — первый прогон пункта 14 (2026-09-03) 🗓 since:2026-09-03](pending/perekosy-istochnikov-pervyy-progon-punkta-14-2026-09-03.md)
- [🟡 Приватный ключ бэкапов существует в одном экземпляре 🗓 since:2026-09-22](pending/privatnyy-klyuch-bekapov-sushchestvuet-v-odnom.md)
- [🟡 На проде висит ключ доступа упразднённой машины PC40 🗓 since:2026-09-22](pending/na-prode-visit-klyuch-dostupa-uprazdnennoy-mashiny-pc40.md)
- [🟡 Файл ужесточения sshd на проде не подключён — лежит мёртвым грузом 🗓 since:2026-09-22](pending/fayl-uzhestocheniya-sshd-na-prode-ne-podklyuchen-lezhit.md)
- [🟡 Парк скачает 209 МБ строк, которыми пока не умеет пользоваться — решение владельца 🗓 since:2026-09-06](pending/park-skachaet-209-mb-strok-kotorymi-poka-ne-umeet.md)
- [🟢 Журнал в PostgreSQL — хвосты J3 после сноса цепочки 🗓 since:2026-09-12](pending/zhurnal-v-postgresql-khvosty-j3-posle-snosa-tsepochki.md)
- [🟡 Список деталей двигателя → строгая таблица `erp_engine_inventory_lines` (E1, E2.2, E2.3 в коде; дальше релиз и контроль на живом потоке, затем E3) 🗓 since:2026-09-05](pending/spisok-detaley-dvigatelya-strogaya-tablitsa-erp-engine.md)
- [🟡 Заказчик двигателя считается из договора: сделан расчёт, остался интерфейс 🗓 since:2026-09-07](pending/zakazchik-dvigatelya-schitaetsya-iz-dogovora-sdelan.md)
- [Anthropic API блокирует РФ-IP → на проде AI работает через DeepSeek, заблокировано только PR-авторевью 🗓 since:2026-06-04](pending/anthropic-api-blokiruet-rf-ip-na-prode-ai-rabotaet.md)
- [🟡 Уникальные ограничения в снимке схемы: сервер починен и выкачен, клиент пока только отчитывается 🗓 since:2026-08-30](pending/unikalnye-ogranicheniya-v-snimke-skhemy-server-pochinen.md)
- [🟡 Переходная EAV-ветка офлайн-гейта — снять на B6 🗓 since:2026-08-30](pending/perekhodnaya-eav-vetka-oflayn-geyta-snyat-na-b6.md)
- [🟡 Хвосты R4a, которые обязаны закрыться ровно на R4b 🗓 since:2026-08-31](pending/khvosty-r4a-kotorye-obyazany-zakrytsya-rovno-na-r4b.md)

---

## ⏳ Ждёт внешнего окна / события

- [Импорт ЗУП: живого образца выгрузки так и не было — проверено на фикстуре 🗓 since:2026-10-18](pending/import-zup-zhivogo-obraztsa-vygruzki-tak-i-ne-bylo.md)
- [🟡 «Кладовщик»: показать раздел кладовщику завода (фаза 2) 🗓 since:2026-10-20](pending/kladovshchik-pokazat-razdel-kladovshchiku-zavoda-faza-2.md)
- [🟡 Почта из программы: транспорт `mailto:`, SMTP — решением владельца 🗓 since:2026-10-21](pending/pochta-iz-programmy-transport-mailto-smtp-resheniem.md)
- [Ложные «Возвраты» в этапах ремонта на проде — пересчёт скриптом, нужно ОК владельца 🗓 since:2026-10-22](pending/lozhnye-vozvraty-v-etapakh-remonta-na-prode-pereschet.md)
- [Висящая rejected-строка этапов: диагноз есть, закрытие — после релиза 3.74.0 с PR-4 🗓 since:2026-10-09](pending/visyashchaya-rejected-stroka-etapov-diagnoz-est.md)
- [Пересадить 3 живых legacy-`user` на роль «Кладовщик» — после релиза с ней и обновления парка 🗓 since:2026-08-28](pending/peresadit-3-zhivykh-legacy-user-na-rol-kladovshchik.md)
- [Переход на нумерацию «Матрица3-РМЗ (N)» — раскат через Заглушку и Диспетчер 🗓 since:2026-08-15](pending/perekhod-na-numeratsiyu-matritsa3-rmz-n-raskat-cherez.md)
- [Ledger release-token протухает ~2026-10-28 (ротирован 2026-09-28) 🗓 since:2026-06-24](pending/ledger-release-token-protukhaet-2026-10-28-rotirovan.md)
- [🔴 Живая приёмка нового установщика (v2026.804.1200) — ДО раскатки на парк 🗓 since:2026-08-04](pending/zhivaya-priemka-novogo-ustanovshchika-v2026-804-1200-do.md)
- [🟢 Android-планшет: ключ подписи заведён, планшет на релизе 🗓 since:2026-08-04](pending/android-planshet-klyuch-podpisi-zaveden-planshet-na.md)
- [🟡 Форс-килл клиента в установщике — сделать безусловным 🗓 since:2026-08-04](pending/fors-kill-klienta-v-ustanovshchike-sdelat-bezuslovnym.md)
- [🟡 Настроить доверенную зону антивируса на парке 🗓 since:2026-08-04](pending/nastroit-doverennuyu-zonu-antivirusa-na-parke.md)
- [Финальная визуальная проверка иконки клиента 🗓 since:2026-05-30](pending/finalnaya-vizualnaya-proverka-ikonki-klienta.md)
- [ADR-0006 mirror-secrets — комната KARMAN подключена, зеркалирование не сделано 🗓 since:2026-06-30 🟡](pending/adr-0006-mirror-secrets-komnata-karman-podklyuchena.md)
- [Хвосты перевода ИИваныча на прямой движок (D-024) 🗓 since:2026-08-10 🟡](pending/khvosty-perevoda-iivanycha-na-pryamoy-dvizhok-d-024.md)
- [Пул соединений PG — понаблюдать после подъёма 🗓 since:2026-08-12 🟡](pending/pul-soedineniy-pg-ponablyudat-posle-podema.md)

---

## [🟢 Прод больше не собирает бэкенд у себя — закрыто 14.09, остался один хвост 🗓 since:2026-09-14](pending/prod-bolshe-ne-sobiraet-bekend-u-sebya-zakryto-14-09.md)

---

## [🟡 Долги, вскрытые разбором мандата D-096 (18.09) 🗓 since:2026-09-18](pending/dolgi-vskrytye-razborom-mandata-d-096-18-09.md)

- [⏳ Живые приёмки сессии 11.10.2026 — после ближайшего выката и обновления парка 🗓 since:2026-10-11](pending/zhivye-priemki-sessii-11-10-2026-posle-blizhayshego.md)
- [⏳ Живые приёмки релиза 3.74.0 — после выката и обновления парка 🗓 since:2026-10-12](pending/zhivye-priemki-reliza-3-74-0-posle-vykata-i-obnovleniya.md)
- [🟡 journald прод-бокса молчит после halt 10.10 — сервер слеп 🗓 since:2026-10-12](pending/journald-prod-boksa-molchit-posle-halt-10-10-server-slep.md)

---

## [🔴 Выкат может положить на проде старый dist, а `/health` это замаскирует 🗓 since:2026-09-30](pending/vykat-mozhet-polozhit-na-prode-staryy-dist-a-health-eto.md)

---

## [🔴 Инцидент 18.09: синхронизация встала у всего парка из-за двух мусорных строк BOM 🗓 since:2026-09-18](pending/intsident-18-09-sinkhronizatsiya-vstala-u-vsego-parka.md)

---

## [🟡 Серверный write-authz (идея #015): механизм есть с 21.09, остались обход ролей и таблица дверей 🗓 since:2026-09-18](pending/servernyy-write-authz-ideya-015-mekhanizm-est-s-21-09.md)

---

## [🟡 Две серверные таблицы с sync-колонками вне контракта синка 🗓 since:2026-09-22](pending/dve-servernye-tablitsy-s-sync-kolonkami-vne-kontrakta.md)

---

## [🟡 Тормоза клиента на слабых машинах: включены замеры, дешёвое починено, остальное ждёт цифр 🗓 since:2026-10-02](pending/tormoza-klienta-na-slabykh-mashinakh-vklyucheny-zamery.md)

---

## [🟡 Веерное ревью не печатает покрытие (идея #293) 🗓 since:2026-09-18](pending/veernoe-revyu-ne-pechataet-pokrytie-ideya-293.md)

---

## [📌 Вложения: кэша на боксе больше нет (решение владельца 14.09)](pending/vlozheniya-kesha-na-bokse-bolshe-net-reshenie-vladeltsa.md)

---

## [🟡 Пересжать уже загруженные снимки 🗓 since:2026-09-14](pending/pereszhat-uzhe-zagruzhennye-snimki.md)

---

## 🟢 Крупные фичи / решения владельца

- [Пакет владельца 12.09: отчёты, спецификации, два учёта 🗓 since:2026-09-12 🟢](pending/paket-vladeltsa-12-09-otchety-spetsifikatsii-dva-ucheta.md)
- [Большой рефакторинг трёх клиентов — остаток программы 🗓 since:2026-08-08 🟡](pending/bolshoy-refaktoring-trekh-klientov-ostatok-programmy.md)
- [Хвосты v3 «Вкладки» после сноса старых оболочек 🗓 since:2026-07-28](pending/khvosty-v3-vkladki-posle-snosa-starykh-obolochek.md)
- [Импорт остатков из 1С — приёмка третьей итерации + автозабор (этап 5) 🗓 since:2026-07-27](pending/import-ostatkov-iz-1s-priemka-tretey-iteratsii.md)
- [«Принят на хранение» — зарезервировать под сценарий долгого хранения + дедлайн 🗓 since:2026-07-29 🟢](pending/prinyat-na-khranenie-zarezervirovat-pod-stsenariy.md)
- [Проверить, что двигатель с PC51 (asia2) доехал сам 🗓 since:2026-07-29 🟡](pending/proverit-chto-dvigatel-s-pc51-asia2-doekhal-sam.md)
- [Идея: производная «стадия» двигателя в карточке (разборка/дефектовка/сборка) 🗓 since:2026-07-29 🟢](pending/ideya-proizvodnaya-stadiya-dvigatelya-v-kartochke.md)
- [Платежи по двигателям — обкатка бухгалтером 🗓 since:2026-07-29 🟢](pending/platezhi-po-dvigatelyam-obkatka-bukhgalterom.md)
- [Хвосты нитки «слоты контракта / печать нарядов» 🗓 since:2026-07-31 🟡](pending/khvosty-nitki-sloty-kontrakta-pechat-naryadov.md)
- [Оформление «Строго/Красиво» — обкатка операторами 🗓 since:2026-07-27](pending/oformlenie-strogo-krasivo-obkatka-operatorami.md)
- [Конструктор → живой дашборд: ждём отзыв операторов 🗓 since:2026-07-19](pending/konstruktor-zhivoy-dashbord-zhdem-otzyv-operatorov.md)
- [Тёплый standby-узел в LAN (Windows-служба, НЕ Docker) 🗓 since:2026-07-19](pending/teplyy-standby-uzel-v-lan-windows-sluzhba-ne-docker.md)
- [Бэклог фич brain (`from-brain/2026-06-04-…`) — остаток 🗓 since:2026-06-04](pending/beklog-fich-brain-from-brain-2026-06-04-ostatok.md)

---

## [🟡 Security hardening — остаток аудита 2026-06-25 🗓 since:2026-06-25](pending/security-hardening-ostatok-audita-2026-06-25.md)

- [🟢 Остаток аудита ролей 2026-08-29 — осознанно НЕ закрытое](pending/ostatok-audita-roley-2026-08-29-osoznanno-ne-zakrytoe.md)

---

## [🟡 Watchdog-агент — остаток приёмки 🗓 since:2026-06-22](pending/watchdog-agent-ostatok-priemki.md)

---

## [🟡 Застрявшее автообновление — осталась ОДНА машина (PC20) 🗓 since:2026-07-17](pending/zastryavshee-avtoobnovlenie-ostalas-odna-mashina-pc20.md)

---

## [🟡 Операционные раскаты (не код — действия владельца/мастеров)](pending/operatsionnye-raskaty-ne-kod-deystviya-vladeltsa.md)

---

## 🟡 Техдолг

- [🟡 План «Сквозной номер РМЗ» лежит активным, хотя код выкачен — проверить и закрыть 🗓 since:2026-10-29](pending/plan-nomerov-rmz-ne-zakryt-v-dokakh-proverit-i-dodelat.md)
- [🟡 web-admin не показывает номер РМЗ: нужен REST-ответ с номером 🗓 since:2026-10-28](pending/web-admin-ne-pokazyvaet-nomer-rmz-nuzhen-rest.md)
- [🟢 Экран «Номера РМЗ» не знает автора старых карточек 🗓 since:2026-10-28](pending/ekran-nomera-rmz-ne-znaet-avtora-starykh-kartochek.md)
- [🟡 Живой `docs/COMPLETED.md` разгружен от старых поколений (638 → 274 КБ), но строки 3.x всё ещё абзацы 🗓 since:2026-10-27](pending/completed-szhat-stroki-pokoleniya-3x.md)
- [CDP-смоук пакета 3.85–3.87 прогнан 21.10 — 52/52; осталось четыре куска 🗓 since:2026-10-21](pending/cdp-smouk-paketa-3-85-3-87-prognan-21-10-52-52-ostalos.md)
- [🔴 Баланс DeepSeek у прод-движка: на нуле оператор не получит ответа вообще 🗓 since:2026-10-23](pending/balans-deepseek-u-prod-dvizhka-na-nule-operator-ne.md)
- [Аварийный режим времени «по интернету + часовой пояс» 🗓 since:2026-10-21](pending/avariynyy-rezhim-vremeni-po-internetu-chasovoy-poyas.md)
- [🟡 Заглушки `U+FFFD` в документах некому заметить: нужен шаг CI 🗓 since:2026-10-19](pending/zaglushki-u-fffd-v-dokumentakh-nekomu-zametit-nuzhen.md)
- [🟢 Масштаб листа в окне предпросмотра печати 🗓 since:2026-10-19](pending/masshtab-lista-v-okne-predprosmotra-pechati.md)
- [🟡 `parent_nomenclature_id` вне контракта синка: реплика не несёт родство деталей 🗓 since:2026-10-18](pending/parent-nomenclature-id-vne-kontrakta-sinka-replika-ne.md)
- [🟡 Смоук `cdp-work-sheets.mjs` устарел на два релиза — единственный e2e по экрану этапов работ 🗓 since:2026-09-16](pending/smouk-cdp-work-sheets-mjs-ustarel-na-dva-reliza.md)
- [🟡 Хвост раздвижной строки этапа работ (C2): «дыхание» полосы прокрутки 🗓 since:2026-09-16](pending/khvost-razdvizhnoy-stroki-etapa-rabot-c2-dykhanie.md)
- [🟡 Обобщённые позиции: три PR-кандидата после E2-доклада 🗓 since:2026-09-17](pending/obobshchennye-pozitsii-tri-pr-kandidata-posle-e2-doklada.md)
- [🟢 Приказы о ценах на услуги: экран есть, карточка услуги пока не заперта 🗓 since:2026-09-12](pending/prikazy-o-tsenakh-na-uslugi-ekran-est-kartochka-uslugi.md)
- [🟡 Слияние дублей сотрудников: хвосты после перевода ссылок 🗓 since:2026-09-11](pending/sliyanie-dubley-sotrudnikov-khvosty-posle-perevoda.md)
- [🟡 Пороги гейта конвейера остались на шкале попыток 🗓 since:2026-09-08](pending/porogi-geyta-konveyera-ostalis-na-shkale-popytok.md)
- [🟡 Журнал пишется до применения: отвергнутая строка всё равно оседает записью 🗓 since:2026-09-08](pending/zhurnal-pishetsya-do-primeneniya-otvergnutaya-stroka.md)
- [🟡 Автомерж: досланный коммит может не уехать — гонка, пойманная на первом применении 🗓 since:2026-09-04](pending/avtomerzh-doslannyy-kommit-mozhet-ne-uekhat-gonka.md)
- [🟢 Ветки-остатки на origin: 15 слитых вычищено, причина найдена 🗓 since:2026-09-04](pending/vetki-ostatki-na-origin-15-slitykh-vychishcheno.md)
- [🟡 `sync_state.client_id` при push — id аккаунта, а не машины (GOTCHAS M102) 🗓 since:2026-09-04](pending/sync-state-client-id-pri-push-id-akkaunta-a-ne-mashiny.md)
- [🟡 Рекламация двигателя осталась в EAV — осознанное отступление от freeze 🗓 since:2026-08-25](pending/reklamatsiya-dvigatelya-ostalas-v-eav-osoznannoe.md)
- [Форматирование ячеек отчётов расползлось копиями 🗓 since:2026-08-22](pending/formatirovanie-yacheek-otchetov-raspolzlos-kopiyami.md)
- [Профиль пользователя пишется чаще, чем нужно: главный источник — `recentVisits` 🗓 since:2026-08-25 🟡](pending/profil-polzovatelya-pishetsya-chashche-chem-nuzhno.md)
- [«Успешно» в панели вложений не всегда значит «сохранено» 🗓 since:2026-08-25 🟢](pending/uspeshno-v-paneli-vlozheniy-ne-vsegda-znachit-sokhraneno.md)
- [Шаг 8a релиза (APK на прод) нечем проверить, и его уже пропускали 🗓 since:2026-08-25 🟡](pending/shag-8a-reliza-apk-na-prod-nechem-proverit-i-ego-uzhe.md)
- [Каталог `uploads` не входит в ночную резервную копию 🗓 since:2026-08-25 🟡](pending/katalog-uploads-ne-vkhodit-v-nochnuyu-rezervnuyu-kopiyu.md)
- [Файлы-сироты: удалять нечем, считать нечем 🗓 since:2026-08-25 🟡](pending/fayly-siroty-udalyat-nechem-schitat-nechem.md)
- [Рейтинг ярлыков начинает с нуля: посев из «Быстрого запуска» отклонён 🗓 since:2026-08-25 🟢](pending/reyting-yarlykov-nachinaet-s-nulya-posev-iz-bystrogo.md)
- [Папки Рабочего стола нельзя двигать: у них нет координат 🗓 since:2026-08-25 🟢](pending/papki-rabochego-stola-nelzya-dvigat-u-nikh-net-koordinat.md)
- [Тест-сторож этапа A оставил три класса непочиненного 🗓 since:2026-08-22](pending/test-storozh-etapa-a-ostavil-tri-klassa-nepochinennogo.md)
- [Параллельный `-r test` даёт случайный красный — это перегруз, а не три бага 🗓 since:2026-08-22](pending/parallelnyy-r-test-daet-sluchaynyy-krasnyy-eto-peregruz.md)
- [Каталог `uploads` не входит в ночную резервную копию 🗓 since:2026-08-20](pending/katalog-uploads-ne-vkhodit-v-nochnuyu-rezervnuyu-kopiyu-2.md)
- [Серверный конструктор отчётов не имеет ни одного экрана 🗓 since:2026-08-20](pending/servernyy-konstruktor-otchetov-ne-imeet-ni-odnogo-ekrana.md)
- [Трёхзначный код договора неоднозначен — 69 договоров на 36 кодов 🗓 since:2026-08-17](pending/trekhznachnyy-kod-dogovora-neodnoznachen-69-dogovorov.md)
- [Осиротевший ключ в `authorized_keys` прода — чей? 🗓 since:2026-08-17](pending/osirotevshiy-klyuch-v-authorized-keys-proda-chey.md)
- [Ещё 12 конфигов на проде забиты нулями — восстановить из пакетов 🗓 since:2026-08-17](pending/eshche-12-konfigov-na-prode-zabity-nulyami-vosstanovit.md)
- [У договоров не заполнен заказчик — привязка по короткому номеру неоднозначна 🗓 since:2026-08-13](pending/u-dogovorov-ne-zapolnen-zakazchik-privyazka-po.md)
- [Пустой дубль «BOM В-84» на проде 🗓 since:2026-07-30](pending/pustoy-dubl-bom-v-84-na-prode.md)
- [Референс-целостность при удалении — остаток данных 🗓 since:2026-07-24](pending/referens-tselostnost-pri-udalenii-ostatok-dannykh.md)
- [Де-дупликация `directory_parts ↔ erp_nomenclature` — хвосты после Ф2 🗓 since:2026-06-29](pending/de-duplikatsiya-directory-parts-erp-nomenclature.md)
- [Унификация оргмоделей (owner batch 2026-06-19, F) 🗓 since:2026-06-19](pending/unifikatsiya-orgmodeley-owner-batch-2026-06-19-f.md)
- [deadcode-сканер — месячная дельта (standing) 🗓 since:2026-06-16](pending/deadcode-skaner-mesyachnaya-delta-standing.md)
- [Ретенция журнала `ledger_tx_index` (831 МБ на 06.09) 🗓 since:2026-06-12](pending/retentsiya-zhurnala-ledger-tx-index-831-mb-na-06-09.md)
- [Серверный pg_trgm typeahead (поиск #035 Ф3) 🗓 since:2026-06-13](pending/servernyy-pg-trgm-typeahead-poisk-035-f3.md)
- [UUID-only склад — задепрайоритизирован (low ROI) 🗓 since:2026-05-27](pending/uuid-only-sklad-zadeprayoritizirovan-low-roi.md)
- [Движение запчастей — рефакторинг: план Ф1–Ф6 закрыт, хвосты по отзыву 🗓 since:2026-07-17 🟢](pending/dvizhenie-zapchastey-refaktoring-plan-f1-f6-zakryt.md)
- [Обкатка «Комплектования двигателя» операторами 🗓 since:2026-07-17 🟢](pending/obkatka-komplektovaniya-dvigatelya-operatorami.md)
- [Обкатка причин утиля 🗓 since:2026-07-17 🟢](pending/obkatka-prichin-utilya.md)
- [Обкатка отчёта «Двигатели и контракты» 🗓 since:2026-07-21 🟢](pending/obkatka-otcheta-dvigateli-i-kontrakty.md)
- [Планшетный режим клиента — Ф1+Ф2 НА ПРОДЕ (v2026.722.917); платформа сменилась на Android 🗓 since:2026-07-21 🔴](pending/planshetnyy-rezhim-klienta-f1-f2-na-prode-v2026-722-917.md)
- [Мелочи (small, по случаю)](pending/melochi-small-po-sluchayu.md)

---

## [🟡 Найдено аудитом бэклога 2026-07-22](pending/naydeno-auditom-bekloga-2026-07-22.md)

- [Дефекты в уже отгруженном](pending/defekty-v-uzhe-otgruzhennom.md)
- [Построено и ни разу не включено](pending/postroeno-i-ni-razu-ne-vklyucheno.md)
- [Хвосты, вынутые из `COMPLETED.md`](pending/khvosty-vynutye-iz-completed-md.md)
- [Гигиена инструментов](pending/gigiena-instrumentov.md)

---

## 🟢 Отложенные фазы / route /zavod

- [Наряды/двигатели — хвосты (Phases на проде) 🗓 since:2026-06-30](pending/naryady-dvigateli-khvosty-phases-na-prode.md)
- [Жизненный цикл двигателя — route /zavod 🗓 since:2026-06-30](pending/zhiznennyy-tsikl-dvigatelya-route-zavod.md)
- [Backfill легаси `variantGroup`-строк 🗓 since:2026-07-06](pending/backfill-legasi-variantgroup-strok.md)
- [Phase 3.8 — вариант B (offline-specs) — отложено 🗓 since:2026-06-18](pending/phase-3-8-variant-b-offline-specs-otlozheno.md)
- [Интерфейс «Резиновый» — опц. полировка 🗓 since:2026-07-09](pending/interfeys-rezinovyy-opts-polirovka.md)
- [Дефектовка → заявка: MVP-3 offline-очередь фото 🗓 since:2026-06-08](pending/defektovka-zayavka-mvp-3-offline-ochered-foto.md)
- [Прогноз — опц. хвост точности 🗓 since:2026-06-22](pending/prognoz-opts-khvost-tochnosti.md)
- [ЗАВОД-контур (route /zavod, не dev) 🗓 since:2026-06-17](pending/zavod-kontur-route-zavod-ne-dev.md)
- [Эскалация ИИваныча меняет состав tools — это стоит всего префикс-кэша 🗓 since:2026-08-30 🟡](pending/eskalatsiya-iivanycha-menyaet-sostav-tools-eto-stoit.md)
- [Джоб chat-learning пишет корпус, которого никто не читает 🗓 since:2026-08-30 🟢](pending/dzhob-chat-learning-pishet-korpus-kotorogo-nikto-ne.md)
- [Остатки на прод-боксе, осознанно не тронутые при обслуживании 30.08 🗓 since:2026-08-30 🟢](pending/ostatki-na-prod-bokse-osoznanno-ne-tronutye-pri.md)
