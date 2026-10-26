# 🟡 Yandex Disk API лихорадит: зеркало 3.75.0 без blockmap 🗓 since:2026-10-13

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟡 Техдолг и отложенное»

Выкат 3.75.0: шаг CI «Upload artifacts to Yandex Disk» упал 504 дважды (137 МБ exe с GH-раннера), докачка с прода — exe и latest.yml встали, blockmap лёг 502/500/503 трижды. На парк не влияет (клиенты обновляются с прода — там все 3 файла + APK, приёмка зелёная). В `/matricarmz/latest` на Яндексе: exe 3.75.0 ✓, latest.yml ✓, **blockmap ✗**; старый 3.74.0 exe цел в корне. Добить один blockmap, когда API отпустит (тот же приём — `upload-yandex-disk.mjs --dir` со стейджинга 3 файлов с прода, токен из env; либо дождаться следующего релиза — скрипт ротирует сам).
