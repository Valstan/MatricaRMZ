#!/usr/bin/env bash
# Smoke test for deploy-backend.sh — выкат бэкенда. Его отказной режим самый дорогой из всех
# ops-скриптов: он бьёт ровно в тот день, когда нужна способность выкатывать. До 2026-09-18
# скрипт сносил прежний `dist` через `rm -rf` без копии, и вернуться было можно только повторным
# выкатом прошлого артефакта — который живёт retention-days: 14.
#
# Гоняет НАСТОЯЩИЙ скрипт с шимами `gh` / `git` / `sudo` / `systemctl` / `curl` / `sleep`,
# поэтому ни сети, ни systemd, ни ожидания в реальном времени здесь нет.
#
#   bash scripts/prod-ops/deploy-backend.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/deploy-backend.sh"
[[ -r "$SUT" ]] || { echo "FAIL: $SUT not found"; exit 1; }

command -v node >/dev/null 2>&1 || { echo "SKIP: node not available — скрипт читает им dependencies"; exit 0; }

ROOT="$(mktemp -d -t deploy-test.XXXXXX)"
trap 'rm -rf "$ROOT"' EXIT
PASS=0
FAILED=0
ok() { PASS=$((PASS + 1)); echo "  ok: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "  FAIL: $1"; }

BIN="$ROOT/bin"
mkdir -p "$BIN"

# --- Шимы. Поведением управляют переменные окружения, выставляемые каждым случаем. -----------

# `curl` — здоровье инстансов. MATRICA_TEST_HEALTH_FAIL_UNTIL: сколько первых вызовов отказать.
# Счётчик в файле, потому что скрипт зовёт curl в подоболочке.
cat > "$BIN/curl" <<'SH'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in *"/health"*) ;; esac; done
n=0
[[ -f "$MATRICA_TEST_CURL_COUNT" ]] && n="$(cat "$MATRICA_TEST_CURL_COUNT")"
n=$((n + 1)); printf '%s' "$n" > "$MATRICA_TEST_CURL_COUNT"
[[ "${MATRICA_TEST_HEALTH_NEVER:-0}" == 1 ]] && exit 22
(( n <= ${MATRICA_TEST_HEALTH_FAIL_UNTIL:-0} )) && exit 22
echo '{"ok":true}'
exit 0
SH

# `sleep` — мгновенный: тест проверяет ширину окна ожидания, а не ждёт её.
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/sleep"
# systemd и права — принимаем и молчим.
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/sudo"
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/systemctl"

# `gh` — авторизован; run list/view отдают фикстуру; download кладёт заранее собранный архив.
cat > "$BIN/gh" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "auth status") exit 0 ;;
  "run list") echo "1111" ;;
  "run view") echo "$MATRICA_TEST_HEAD_SHA" ;;
  "run download")
    dir=""; prev=""
    for a in "$@"; do [[ "$prev" == "--dir" ]] && dir="$a"; prev="$a"; done
    cp "$MATRICA_TEST_TARBALL" "$dir/backend-dist.tar.gz" ;;
esac
exit 0
SH

# `git` — pull молчит, rev-parse отдаёт тот же sha (чтобы не шумело про расхождение).
cat > "$BIN/git" <<'SH'
#!/usr/bin/env bash
[[ "$1" == "rev-parse" ]] && { echo "$MATRICA_TEST_HEAD_SHA"; exit 0; }
exit 0
SH

chmod +x "$BIN"/*
export PATH="$BIN:$PATH"
export MATRICA_TEST_HEAD_SHA="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

# --- Сборка артефакта с НОВЫМ содержимым --------------------------------------------------
ART="$ROOT/artifact"
mkdir -p "$ART/backend-api/dist" "$ART/backend-api/drizzle" "$ART/shared/dist" "$ART/ledger/dist" "$ART/web-admin/dist"
echo "NEW" > "$ART/backend-api/dist/index.js"
echo "NEW" > "$ART/backend-api/drizzle/marker"
echo "NEW" > "$ART/shared/dist/marker"
echo "NEW" > "$ART/ledger/dist/marker"
echo "NEW" > "$ART/web-admin/dist/index.html"
export MATRICA_TEST_TARBALL="$ROOT/backend-dist.tar.gz"
tar -czf "$MATRICA_TEST_TARBALL" -C "$ART" backend-api/dist backend-api/drizzle shared/dist ledger/dist web-admin/dist
# Архив образца до 21.09 — без админки. Прод его обязан отвергнуть до сноса, иначе `/admin-ui`
# исчезнет вместе с прежним каталогом.
export MATRICA_TEST_TARBALL_NO_ADMIN="$ROOT/backend-dist-no-admin.tar.gz"
tar -czf "$MATRICA_TEST_TARBALL_NO_ADMIN" -C "$ART" backend-api/dist backend-api/drizzle shared/dist ledger/dist

# Свежий прод-клон с ПРЕЖНИМ содержимым перед каждым случаем.
make_repo() {
  local repo="$1" deps="$2"
  rm -rf "$repo"
  mkdir -p "$repo/backend-api/dist" "$repo/backend-api/drizzle" "$repo/shared/dist" "$repo/ledger/dist" "$repo/web-admin/dist"
  echo "OLD" > "$repo/backend-api/dist/index.js"
  echo "OLD" > "$repo/backend-api/drizzle/marker"
  echo "OLD" > "$repo/shared/dist/marker"
  echo "OLD" > "$repo/ledger/dist/marker"
  echo "OLD" > "$repo/web-admin/dist/index.html"
  printf '{"name":"@matricarmz/backend-api","dependencies":%s}' "$deps" > "$repo/backend-api/package.json"
}
install_dep() { mkdir -p "$1/backend-api/node_modules/$2"; }

run_deploy() {
  local repo="$1"
  export MATRICA_REPO_DIR="$repo"
  export MATRICA_TEST_CURL_COUNT="$ROOT/curl.count"
  rm -f "$MATRICA_TEST_CURL_COUNT"
  ( cd "$repo" && bash "$SUT" ) > "$ROOT/out.txt" 2>&1
  echo $?
}

echo "deploy-backend.sh smoke"

# --- 1. Счастливый путь -------------------------------------------------------------------
REPO="$ROOT/repo1"; make_repo "$REPO" '{"express":"5.0.0"}'; install_dep "$REPO" express
RC="$(MATRICA_TEST_HEALTH_FAIL_UNTIL=0 run_deploy "$REPO")"
[[ "$RC" == 0 ]] && ok "успешный выкат выходит с 0" || fail "успешный выкат вернул $RC"
[[ "$(cat "$REPO/backend-api/dist/index.js")" == "NEW" ]] && ok "новый dist разложен" || fail "новый dist не разложен"
ls -d "$REPO"/.deploy-backup/*/ >/dev/null 2>&1 && ok "копия прежнего dist создана" || fail "копии прежнего dist нет"
BK="$(ls -d "$REPO"/.deploy-backup/*/ | head -1)"
[[ "$(cat "$BK/backend-api/dist/index.js")" == "OLD" ]] && ok "в копии лежит именно прежний dist" || fail "копия не содержит прежний dist"
[[ "$(cat "$REPO/web-admin/dist/index.html")" == "NEW" ]] && ok "админка разложена вместе с бэкендом" || fail "web-admin/dist не разложен"
[[ "$(cat "$BK/web-admin/dist/index.html")" == "OLD" ]] && ok "прежняя админка в копии" || fail "web-admin/dist не скопирован"

# --- 2. Primary не поднялся → откат --------------------------------------------------------
REPO="$ROOT/repo2"; make_repo "$REPO" '{"express":"5.0.0"}'; install_dep "$REPO" express
RC="$(MATRICA_TEST_HEALTH_NEVER=1 run_deploy "$REPO")"
[[ "$RC" != 0 ]] && ok "провал health primary выходит с ошибкой" || fail "провал health вернул 0"
[[ "$(cat "$REPO/backend-api/dist/index.js")" == "OLD" ]] \
  && ok "ОТКАТ: прежний dist возвращён на место" || fail "отката не произошло — на диске остался новый dist"
[[ "$(cat "$REPO/shared/dist/marker")" == "OLD" ]] && ok "откат вернул и shared/dist" || fail "shared/dist не откачен"
[[ "$(cat "$REPO/web-admin/dist/index.html")" == "OLD" ]] && ok "откат вернул и админку" || fail "web-admin/dist не откачен"
grep -q "ОТКАТ" "$ROOT/out.txt" && ok "откат назван в логе" || fail "лог молчит про откат"

# --- 3. Не установлена рантаймовая зависимость → отказ ДО сноса -----------------------------
REPO="$ROOT/repo3"; make_repo "$REPO" '{"express":"5.0.0","brand-new-dep":"1.0.0"}'; install_dep "$REPO" express
RC="$(MATRICA_TEST_HEALTH_FAIL_UNTIL=0 run_deploy "$REPO")"
[[ "$RC" != 0 ]] && ok "пропущенный install останавливает выкат" || fail "выкат прошёл без установленной зависимости"
[[ "$(cat "$REPO/backend-api/dist/index.js")" == "OLD" ]] \
  && ok "прежний dist не тронут — отказ случился ДО rm -rf" || fail "dist заменён до проверки зависимостей"
[[ ! -d "$REPO/.deploy-backup" ]] && ok "копия не создавалась: сносить было нечего" || fail "создана лишняя копия"
grep -q "brand-new-dep" "$ROOT/out.txt" && ok "недостающая зависимость названа поимённо" || fail "лог не назвал зависимость"

# --- 4. Окно ожидания primary не короче канонических 90 с ----------------------------------
# 35 отказов health = 70 с по два: прежнее окно в 60 с объявило бы здоровый primary упавшим.
REPO="$ROOT/repo4"; make_repo "$REPO" '{"express":"5.0.0"}'; install_dep "$REPO" express
RC="$(MATRICA_TEST_HEALTH_FAIL_UNTIL=35 run_deploy "$REPO")"
[[ "$RC" == 0 ]] && ok "primary, поднявшийся за 70 с, считается здоровым (окно ≥90 с)" \
  || fail "primary за 70 с объявлен упавшим — окно короче канона"
[[ "$(cat "$REPO/backend-api/dist/index.js")" == "NEW" ]] \
  && ok "медленный, но здоровый primary не вызвал ложный откат" || fail "ложный откат по медленному старту"

# --- 5. Старые копии подрезаются, свежие остаются -------------------------------------------
REPO="$ROOT/repo5"; make_repo "$REPO" '{"express":"5.0.0"}'; install_dep "$REPO" express
mkdir -p "$REPO/.deploy-backup/20200101-000001" "$REPO/.deploy-backup/20200101-000002" \
         "$REPO/.deploy-backup/20200101-000003" "$REPO/.deploy-backup/20200101-000004"
RC="$(MATRICA_DEPLOY_BACKUP_KEEP=3 MATRICA_TEST_HEALTH_FAIL_UNTIL=0 run_deploy "$REPO")"
COUNT="$(ls -1 "$REPO/.deploy-backup" | wc -l | tr -d ' ')"
[[ "$RC" == 0 && "$COUNT" == 3 ]] && ok "оставлено ровно 3 копии (было 4 старых + новая)" \
  || fail "подрезка копий: rc=$RC, осталось $COUNT вместо 3"
[[ ! -d "$REPO/.deploy-backup/20200101-000001" ]] && ok "снесена самая старая копия" || fail "старая копия уцелела"

# --- 6. Архив без админки (сборка до 21.09) → отказ ДО сноса ---------------------------------
REPO="$ROOT/repo6"; make_repo "$REPO" '{"express":"5.0.0"}'; install_dep "$REPO" express
RC="$(MATRICA_TEST_TARBALL="$MATRICA_TEST_TARBALL_NO_ADMIN" MATRICA_TEST_HEALTH_FAIL_UNTIL=0 run_deploy "$REPO")"
[[ "$RC" != 0 ]] && ok "архив без web-admin/dist отвергнут" || fail "архив без админки принят"
[[ "$(cat "$REPO/web-admin/dist/index.html")" == "OLD" && "$(cat "$REPO/backend-api/dist/index.js")" == "OLD" ]]   && ok "ничего не тронуто — отказ случился до rm -rf" || fail "dist заменён неполным архивом"
grep -q "web-admin/dist" "$ROOT/out.txt" && ok "недостающий путь назван" || fail "лог не назвал недостающий путь"

echo "deploy-backend.sh: $PASS ok, $FAILED failed"
[[ "$FAILED" == 0 ]] || exit 1
