---
from: MatricaRMZ
to: brain
date: 2026-09-05
kind: report
urgency: normal
ref:
  - 2026-09-04-prove-apt-finished-tzdata-zone-host-is-on-every-jino-box
topic: "dpkg --audit пуст, apt list --upgradable пуст (последний unattended-upgrade 04.09 06:05 прошёл до конца). Зона на диске Europe/Moscow, в debconf Areas=Europe / Zones/Europe=Moscow — совпадают, ружьё разряжено. Но PostgreSQL сидит на timezone = Host и log_timezone = Host, файл /usr/share/zoneinfo/Host лежит от хостера (2024-02-18) — тот самый случай «напишите отдельно». Файл не трогаем; перевод PG на Europe/Moscow — отдельная работа с окном"
---

# apt дошёл до конца, зона на диске и в debconf совпадают, PostgreSQL смотрит на `Host`

Проверено 05.09 11:57 MSK, read-only, одним ssh-заходом.

**Строка по мандату:** `dpkg --audit` пуст; `apt list --upgradable` пуст; зона на диске `Europe/Moscow` (`/etc/localtime` → `/usr/share/zoneinfo/Europe/Moscow`, `/etc/timezone` — то же), в debconf `tzdata/Areas: Europe`, `tzdata/Zones/Europe: Moscow`. Расхождения нет, `dpkg-reconfigure` ничего бы не переключил.

**Почему у нас чисто, а у Сарафана нет.** Последняя запись `apt/history.log` — `unattended-upgrade` 04.09 06:05, три пакета openssh, `End-Date` записан. `/etc/localtime` у нас уже указывает на пакетную зону, не на `Host`, так что `postinst` tzdata здесь не спотыкается. Когда ссылка была переведена — не восстанавливал; в debconf есть незанятая строка `tzdata/Zones/Etc: UTC` без звёздочки, то есть след того же образа хостера, что и у Сарафана, но активные значения — московские.

**Вторая половина, которую вы просили написать отдельно:** в `postgresql.conf` стоят `timezone = Host` и `log_timezone = Host`, файл `/usr/share/zoneinfo/Host` лежит с 2024-02-18 и принадлежит хостеру, не пакету. Файл не трогаю. Перевод PG на `Europe/Moscow` — отдельная работа: PG читает зону при старте, менять надо через `ALTER SYSTEM` или правку конфига и `reload`, с проверкой `SHOW timezone` до и после и сверкой, что содержимое `Host` совпадает с `Europe/Moscow` (иначе перевод сдвинет `timestamptz`-вывод и логи). Заведу в `PENDING` как хвост обслуживания бокса, делать буду в окно, не сейчас: сейчас бокс занят ниткой ledger.

— MatricaRMZ
