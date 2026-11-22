#!/usr/bin/env python3
"""Пин рабочих адресов MiniMax в /etc/hosts — для прод-бокса «Матрицы РМЗ».

**Зачем.** DNS-резолверы VPS отдают для ``*.minimax.io`` адреса Akamai, до которых
соединение **не устанавливается** (таймаут), а резолвер 1.1.1.1 отдаёт другие — до них
соединение поднимается за доли секунды. Проверено на боксе «Матрицы РМЗ» 22.11.2026:
``api.minimax.io`` → ``2a02:26f0:...`` (IPv6) и ``account.minimax.io`` → ``2.21.173.162``
— оба таймаутятся; через 1.1.1.1 те же хосты отдают живые адреса.

**Как.** Скрипт спрашивает A-записи у нескольких резолверов, оставляет только те
адреса, до которых реально доходит TCP-соединение на 443, и записывает их в
``/etc/hosts``. ``nsswitch`` на боксе читает ``files`` раньше ``dns``, поэтому запись
выигрывает у резолвера.

**Почему это не «костыль, а правильное место».** Адреса Akamai ротируются, и запись
вручную протухнет — поэтому скрипт запускается по таймеру (раз в час достаточно) и
перезаписывает свою секцию целиком.

Запуск на боксе:

    sudo python3 ~/MatricaRMZ/scripts/prod-ops/minimax-dns-pin.py
    # или с проверкой, что адреса действительно живые:
    sudo python3 ~/MatricaRMZ/scripts/prod-ops/minimax-dns-pin.py --check

Тот же приём применён в «Сарафане» (``scripts/minimax_dns_pin.py``, ADR-0017) — там
резолверы бокса отдавали недоступные адреса точно так же.
"""

from __future__ import annotations

import argparse
import os
import socket
import struct
import sys
from pathlib import Path
from typing import Dict, List

HOSTS = (
    "agent.minimax.io",
    "account.minimax.io",
    "platform.minimax.io",
    "api.minimax.io",
    "www.minimax.io",
)
RESOLVERS = ("1.1.1.1", "9.9.9.9", "8.8.8.8")
# Путь к файлу hosts — переопределяется только для приёмки (тест гоняет на фикстуре).
HOSTS_PATH = Path(os.environ.get("MATRICA_MINIMAX_PIN_HOSTS") or "/etc/hosts")
# Фикстура адресов "host=ip,host=ip" — пропускает сетевую часть (приёмка без сети).
ADDRESSES_FIXTURE = os.environ.get("MATRICA_MINIMAX_PIN_FIXTURE") or ""
MARK = "# minimax-pin (обновляется скриптом minimax-dns-pin.py)"


def query(server: str, host: str, timeout: float = 5.0) -> List[str]:
    """A-записи хоста через UDP/53 (свой запрос — без внешних зависимостей)."""
    header = struct.pack(">HHHHHH", 0x4242, 0x0100, 1, 0, 0, 0)
    qname = b"".join(bytes([len(p)]) + p.encode() for p in host.split(".")) + b"\x00"
    packet = header + qname + struct.pack(">HH", 1, 1)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(packet, (server, 53))
        data, _ = sock.recvfrom(4096)
    except Exception:  # noqa: BLE001
        return []
    finally:
        sock.close()
    ancount = struct.unpack(">H", data[6:8])[0]
    offset = 12
    while offset < len(data) and data[offset]:
        offset += data[offset] + 1
    offset += 1 + 4
    addrs: List[str] = []
    for _ in range(ancount):
        if offset >= len(data):
            break
        if data[offset] & 0xC0 == 0xC0:
            offset += 2
        else:
            while offset < len(data) and data[offset]:
                offset += data[offset] + 1
            offset += 1
        if offset + 10 > len(data):
            break
        rtype, _, _, rdlen = struct.unpack(">HHIH", data[offset : offset + 10])
        offset += 10
        if rtype == 1 and rdlen == 4:
            addrs.append(socket.inet_ntoa(data[offset : offset + 4]))
        offset += rdlen
    return addrs


def reachable(addr: str, timeout: float = 4.0) -> bool:
    """Доходит ли TCP-соединение до адреса."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((addr, 443))
        return True
    except Exception:  # noqa: BLE001
        return False
    finally:
        sock.close()


def pick(host: str) -> str:
    """Первый адрес, до которого доходит соединение."""
    for resolver in RESOLVERS:
        for addr in query(resolver, host):
            if reachable(addr):
                return addr
    return ""


def pick_from_fixture(raw: str) -> Dict[str, str]:
    """Адреса из фикстуры "host=ip,host=ip" — сетевой части нет (приёмка)."""
    out: Dict[str, str] = {}
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk or "=" not in chunk:
            continue
        host, _, addr = chunk.partition("=")
        host = host.strip()
        addr = addr.strip()
        if host in HOSTS and addr:
            out[host] = addr
    return out


def render_section(addresses: Dict[str, str]) -> List[str]:
    """Строки секции пина: по одной на хост, в порядке HOSTS."""
    lines: List[str] = []
    for host in HOSTS:
        addr = addresses.get(host, "")
        if addr:
            lines.append("%s %s" % (addr, host))
        else:
            print("%-22s -> рабочего адреса не нашлось" % host, file=sys.stderr)
    return lines


def merge_hosts_file(existing: List[str], section: List[str]) -> str:
    """Собирает новый файл hosts: чужие строки как есть, секция пина — одна и последняя.

    ⚠️ Раньше выкидался только заголовок секции, а её строки — нет. Каждый прогон
    оставлял свои 5 адресов НАД свежими, и резолв (getaddrinfo отдаёт адреса в порядке
    файла) начинался со старых, уже мёртвых: Node пробует IPv4-адреса по порядку, и
    мёртвый первый съедал весь таймаут агента (120 с) при живом аккаунте пула.
    Теперь выкидываются все строки наших хостов — и прошлые блоки, и текущий.
    """
    kept: List[str] = []
    for ln in existing:
        if MARK in ln:
            continue
        parts = ln.split()
        if len(parts) == 2 and parts[1] in HOSTS:
            continue
        kept.append(ln)
    body = "\n".join(kept).rstrip("\n")
    head = f"{body}\n" if body else ""
    return head + MARK + "\n" + "\n".join(section) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="Пин адресов MiniMax в /etc/hosts")
    ap.add_argument("--check", action="store_true", help="только проверить, ничего не писать")
    args = ap.parse_args()

    if ADDRESSES_FIXTURE:
        addresses = pick_from_fixture(ADDRESSES_FIXTURE)
    else:
        addresses = {host: pick(host) for host in HOSTS}
    for host in HOSTS:
        addr = addresses.get(host, "")
        if addr:
            print("%-22s -> %s" % (host, addr))

    lines = render_section(addresses)
    if not lines:
        return 1

    if args.check:
        return 0

    existing = HOSTS_PATH.read_text(encoding="utf-8").splitlines() if HOSTS_PATH.exists() else []
    content = merge_hosts_file(existing, lines)
    # Замена атомарная: пишем во временный файл рядом и переименовываем. Прямая запись
    # обрезает /etc/hosts на старте — и падение процесса посреди записи (а бокс у нас
    # 1536 МБ без swap, OOM-killer не выдумка) оставило бы файл ПУСТЫМ, то есть
    # сломанным DNS для всего бокса, а не только для MiniMax.
    tmp = HOSTS_PATH.with_name(HOSTS_PATH.name + ".minimax-pin.tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, HOSTS_PATH)
    print("записано в %s: %d строк" % (HOSTS_PATH, len(lines)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
