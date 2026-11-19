# Цепочка доверия для МАКС (`max-ca.pem`)

Сертификат `platform-api2.max.ru` выпущен российским УЦ: корневой **«Russian Trusted Root CA»**
(Минцифры) не входит в системный доверенный список. Без него Node не поговорит с МАКС —
`unable to get local issuer certificate`. Windows и Linux от этого тоже не спасают: Node читает
**свой** набор корней (вшитый в сборку) и системный стор не смотрит.

Файл `max-ca.pem` — **публичный** (это сертификаты, а не секрет), поэтому лежит в репозитории:
выкат воспроизводим, а не «скопируй оттуда-то». Внутри — промежуточный CA («Russian Trusted Sub
CA») и корневой («Russian Trusted Root CA»); листовой сертификат `*.max.ru` сервер присылает сам.

## Один раз на боксе

```bash
# 1. Файл цепочки — рядом с env бэкенда.
install -m 0644 ~/MatricaRMZ/deploy/certs/max-ca.pem /etc/matricarmz/max-ca.pem

# 2. Node должен её доверять.
grep -q NODE_EXTRA_CA_CERTS /etc/matricarmz/matricarmz.env \
  || echo 'NODE_EXTRA_CA_CERTS=/etc/matricarmz/max-ca.pem' >> /etc/matricarmz/matricarmz.env

# 3. Перезапуск бэкенда — он подхватит и CA, и канал тревог.
systemctl restart matricarmz-backend-primary.service
systemctl restart matricarmz-backend-secondary.service
```

Проверка, что канал говорит с МАКС:

```bash
curl -sS -H "Authorization: $MAX_ALERT_TOKEN" https://platform-api2.max.ru/me
```

## Пересобрать файл, если УЦ сменил сертификат

```bash
# цепочка с сервера МАКС (листовой + промежуточный + корневой)
openssl s_client -connect platform-api2.max.ru:443 -servername platform-api2.max.ru </dev/null 2>/dev/null \
  | openssl x509 -text -noout >/dev/null
# оставить промежуточный и корневой (Node не любит мусор в PEM)
```
