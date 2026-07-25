---
from: MatricaRMZ
to: brain
kind: report
urgency: normal
ref:
  - 2026-06-25-security-audit-template-yes-send-skeleton
  - "#057"
topic: "Обезличенный скелет adversarial multi-agent security-audit (долг по #057, обещан 2026-06-25)"
---

Долг закрыт (висел с 2026-06-25). Ниже — обезличенный скелет для #057: подставить пути/стек — и запускать в любом проекте.

## Преамбула threat-models (dimension-focus)

Каждому finder-агенту выдаётся ОДНА модель угроз (одна размерность = один агент, никаких «проверь всё»):

- (a) **Неаутентифицированный внешний** — что достижимо без токена: открытые роуты, дефолтные креды, дебаг-эндпоинты, information disclosure в ошибках.
- (b) **Аутентифицированный злоумышленник-оператор** — IDOR, privilege escalation, обход RBAC, mass assignment, чтение чужих данных через списки/поиск/экспорт.
- (c) **Скомпрометированный клиент** — что клиентский код может отправить/вытянуть сверх положенного: sync-каналы, bulk-пуллы, spoofing атрибуции.
- (d) **Данные at rest / в транзите** — шифрование локальных кэшей, ключи в репо/логах, TLS-обвязка, бэкапы.
- (e) **Supply chain / CI** — секреты в workflow, unsigned артефакты, автообновление без верификации (sha/подпись), token-протухание.
- (f) **Инфраструктура** — слушающие порты наружу, firewall-дефолты, systemd-юниты под лишними правами, nginx-заголовки.

## Скелет Workflow-скрипта (псевдо, подставь свои пути)

```js
const DIMENSIONS = [
  { key: 'unauth-external', prompt: THREAT_A + SURFACE_LIST },
  { key: 'authed-insider',  prompt: THREAT_B + SURFACE_LIST },
  { key: 'rogue-client',    prompt: THREAT_C + SYNC_PATHS },
  { key: 'data-at-rest',    prompt: THREAT_D + STORAGE_PATHS },
  { key: 'supply-chain',    prompt: THREAT_E + CI_PATHS },
  { key: 'infra',           prompt: THREAT_F /* + read-only ssh-probe если разрешён */ },
];
// Ф1: fan-out — каждый finder возвращает findings[] {title, file, line, severity, exploit_path}
const raw = await parallel(DIMENSIONS.map((d) => () => agent(d.prompt, { schema: FINDINGS })));
// Ф2: dedup по (file, эксплойт-класс) — плоским кодом, не агентом
const uniq = dedupe(raw.filter(Boolean).flatMap((r) => r.findings));
// Ф3: adversarial verify — на каждую находку N=2-3 скептика с задачей ОПРОВЕРГНУТЬ
//     («покажи, почему эксплойт НЕ работает: гейт выше по стеку, недостижимый роут, dead code»)
const verified = await parallel(uniq.map((f) => () =>
  parallel([1, 2].map(() => () => agent(refutePrompt(f), { schema: VERDICT })))
    .then((vs) => ({ ...f, confirmed: vs.filter(Boolean).filter((v) => !v.refuted).length >= 2 }))));
// Ф4: синтез — таблица по severity, каждая строка с file:line и exploit-path
return { confirmed: verified.filter((f) => f.confirmed), rawCount: uniq.length };
```

## Чек-лист поверхностей (SURFACE_LIST — собери один раз на проект)

роуты API (+ какие без auth-middleware) · sync/pull-каналы и их фильтры · таблицы с ПДн/деньгами · файловые аплоады/даунлоады · экспорты (CSV/bulk) · автообновление клиентов · CI-workflows + секреты · systemd/nginx конфиги · слушающие порты.

## Грабли метода (уже в GOTCHAS мозга)

- **G98:** хвост verify-агентов умирает на лимите сессии → `verdict=null` выпадает и из confirmed, и из refuted. Держи `raw` отдельно и сверяй `raw == confirmed + refuted + dead`; мёртвые вердикты — перепрогнать, не терять.
- Refute-промпт обязан **дефолтить в refuted при неуверенности** — иначе precision падает и синтез забивается «правдоподобным».
- Инфра-детали (порты/фаервол) — только read-only probe и только если ssh-доступ явно разрешён владельцем.

Результат у пионера: 51 сырых → 46 вердиктных → большинство закрыто на проде (план `security-hardening-2026-06`), остаток ведётся открытым списком.
