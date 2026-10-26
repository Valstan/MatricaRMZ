# Ещё 12 конфигов на проде забиты нулями — восстановить из пакетов 🗓 since:2026-08-17

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟡 Техдолг»

Скан `/etc` (весь конвейер под root — иначе ложные срабатывания, GOTCHAS **M86**) нашёл 13 файлов из одних `NUL`. Один (`rsyslog.d/50-default.conf`) починен, остальные лежат как есть:

| Файл | Байт | Чем грозит |
|---|---|---|
| `/etc/nsswitch.conf` | 494 | порядок разрешения пользователей/групп/хостов; сейчас работают вкомпилированные дефолты glibc |
| `/etc/profile` | 582 | login-shell не подхватывает `/etc/profile.d/*` (PATH и пр.) |
| `/etc/hosts.allow`, `/etc/hosts.deny` | 411 / 711 | tcp-wrappers; на практике почти не используются |
| `/etc/locale.conf` | 35 | локаль по умолчанию |
| `/etc/networks` | 91 | таблица сетей |
| `/etc/python3/debian_config` | 94 | конфиг питона Debian |
| `/etc/init.d/bind9`, `/etc/init.d/wide-dhcpv6-client` | 372 / 300 | sysv-скрипты неиспользуемых служб |
| `/etc/postgresql-common/root.crt` | 607 | корневой сертификат для `verify-ca` (мы им не пользуемся) |
| `/etc/ssh/sshd_config.ucf-dist` | 3502 | packaging-остаток, не читается sshd |
| `/etc/nginx/conf.d/archive/matricarmz-backend.conf.bak` | 2360 | **наш** архивный бэкап, не наш конфиг |

Значимые — `nsswitch.conf` и `/etc/profile`: система жива на дефолтах, но это мина. Восстанавливать пакетными эталонами (`dpkg -S <файл>` → `apt-get install --reinstall -o Dpkg::Options::="--force-confmiss"` после удаления обнулённого conffile; для не-conffile — копия из `/usr/share/...`, как у rsyslog). **Не делалось в эту сессию:** трогать `nsswitch.conf` на живом сервере без нужды рискованнее, чем оставить как есть, — просить окно у владельца. Первопричина обнуления не найдена (сроки правок — с 2025-12 по 2026-05), см. память `prod-config-corruption-pattern`.
