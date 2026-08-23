#!/usr/bin/env bash
# Рендерит и устанавливает systemd-юниты backend-api из шаблонов в этой папке.
#
# Шаблоны matricarmz-backend-{primary,secondary}.service содержат плейсхолдеры:
#   __MATRICA_USER__      — сервисный пользователь (по умолчанию: кто запускает скрипт)
#   __MATRICA_REPO_DIR__  — клон репозитория на сервере (по умолчанию: $HOME/MatricaRMZ)
# Имя пользователя и путь к клону в репозиторий не пишем (AGENTS.md §recon-поверхность),
# поэтому подстановка делается здесь, на сервере.
#
# Запускать на проде от сервисного пользователя из корня клона:
#   bash deploy/systemd/install-backend.sh
# Переопределить значения: MATRICA_USER=... MATRICA_REPO_DIR=... bash deploy/systemd/install-backend.sh
# Только показать результат рендера, ничего не трогая: DRY_RUN=1 bash deploy/systemd/install-backend.sh
#
# Скрипт НЕ рестартует сервисы — только install + daemon-reload; перед записью печатает diff
# с уже установленным юнитом. Рестарт — отдельным шагом релиза (AGENTS.md §Release process).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MATRICA_USER="${MATRICA_USER:-$(id -un)}"
MATRICA_REPO_DIR="${MATRICA_REPO_DIR:-$HOME/MatricaRMZ}"
DRY_RUN="${DRY_RUN:-0}"
UNITS=(matricarmz-backend-primary.service matricarmz-backend-secondary.service)

render() {
  sed -e "s|__MATRICA_USER__|$MATRICA_USER|g" -e "s|__MATRICA_REPO_DIR__|$MATRICA_REPO_DIR|g" "$1"
}

echo "==> MATRICA_USER=$MATRICA_USER MATRICA_REPO_DIR=$MATRICA_REPO_DIR"
if [[ "$DRY_RUN" != 1 && ! -d "$MATRICA_REPO_DIR/backend-api" ]]; then
  echo "ERROR: $MATRICA_REPO_DIR/backend-api не найден — задайте MATRICA_REPO_DIR" >&2
  exit 1
fi

changed=0
for unit in "${UNITS[@]}"; do
  src="$SCRIPT_DIR/$unit"
  dst="/etc/systemd/system/$unit"
  [[ -f "$src" ]] || { echo "ERROR: нет шаблона $src" >&2; exit 1; }

  tmp="$(mktemp)"
  render "$src" > "$tmp"
  if grep -q '__MATRICA_' "$tmp"; then
    echo "ERROR: в $unit остался неподставленный плейсхолдер" >&2
    rm -f "$tmp"
    exit 1
  fi

  if [[ "$DRY_RUN" == 1 ]]; then
    echo "----- $unit (рендер) -----"
    cat "$tmp"
    rm -f "$tmp"
    continue
  fi

  if [[ -f "$dst" ]] && diff -u "$dst" "$tmp"; then
    echo "==> $unit: без изменений"
    rm -f "$tmp"
    continue
  fi

  echo "==> Устанавливаю $dst (diff выше, если юнит уже стоял)"
  sudo install -m 0644 "$tmp" "$dst"
  rm -f "$tmp"
  changed=1
done

if [[ "$DRY_RUN" == 1 ]]; then
  exit 0
fi

if [[ "$changed" == 1 ]]; then
  echo "==> systemctl daemon-reload"
  sudo systemctl daemon-reload
fi

echo
echo "Готово. Сервисы не перезапускались. Рестарт отдельным шагом:"
echo "  sudo systemctl restart ${UNITS[*]}"
