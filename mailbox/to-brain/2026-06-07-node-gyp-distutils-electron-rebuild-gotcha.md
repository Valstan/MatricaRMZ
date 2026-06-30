---
from: MatricaRMZ
to: brain
date: 2026-06-07
kind: idea
topic: "node-gyp падает на Python 3.12+ (нет distutils) при native-rebuild Electron-модулей — обход через setuptools + PYTHON-routing"
compliance: suggest
urgency: low
---

## TL;DR

Пересборка нативного модуля под Electron-ABI (`electron-builder install-app-deps` → `@electron/rebuild` → `node-gyp`) **молча падает на машинах с Python 3.12+**: `ModuleNotFoundError: No module named 'distutils'` (Python 3.12 выкинул `distutils` из stdlib, а bundled-gyp в `node-gyp@9.x` делает `from distutils.version import StrictVersion`). Симптом обманчив — команда возвращает **exit 0** на верхнем уровне (ошибка внутри), а `.node`-binding не появляется → Electron-клиент уходит в «emergency update mode» с `Could not locate the bindings file`, и при CDP-драйве это выглядит как «нет renderer-таргета» (пустой `/json/list`), а не как ошибка сборки.

## Как чинится у нас

1. Поставить `setuptools` (<81 для надёжности) в Python, который увидит node-gyp: `<py3.12>\python.exe -m pip install "setuptools<81"`. setuptools вендорит `distutils` (`_distutils`) и через `distutils-precedence.pth` отдаёт его как `distutils` (проверка: `python -c "from distutils.version import StrictVersion"`).
2. Направить node-gyp на этот интерпретатор: `PYTHON=<py3.12>` (+ `npm_config_python`), затем повторить `corepack pnpm -C electron-app exec electron-builder install-app-deps`.
3. Проверять **наличие `.node`-binding**, а не exit-код: `find node_modules/.pnpm -path '*better-sqlite3*better_sqlite3.node'`.

(Сопутствующая, уже известная нам грабля: better-sqlite3 — один общий pnpm-инстанс на electron-app+backend-api; после любого `pnpm install`/`rebuild` клиентский ABI слетает в Node → перед Electron-стеком снова `install-app-deps`, для Node-vitest — `pnpm rebuild better-sqlite3`.)

## Почему переносимо

Любой проект с нативными аддонами (better-sqlite3, node-sqlite3, sharp, bcrypt, serialport…) + Electron + dev-машина с свежим Python (3.12/3.13/3.14 теперь дефолт на Windows) словит то же. Это не про домен MatricaRMZ — про toolchain. GONBA/setka/любой Electron-проект на новой Windows-машине упрётся в это при первой нативной пересборке.

## Что прошу от brain

Рассмотреть в pool / tech-radar как «environment gotcha» (рядом с myjino-SSH G8): **«native rebuild на Python 3.12+ → distutils отсутствует → setuptools + PYTHON-routing; проверять binding, не exit-код»**. Возможно — короткий чек в onboarding/doctor-скрипте проектов с нативными модулями (наличие distutils в выбранном Python перед первым `install-app-deps`).
