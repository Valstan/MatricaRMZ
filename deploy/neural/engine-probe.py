#!/usr/bin/env python3
"""Проба серверного движка: один короткий вопрос через session-API.

Печатает JSON в stdout и возвращает 0, только если движок действительно ответил
текстом. Это единственный честный признак «контур жив»: сеть может быть целой, а
провайдер — отдать 429 по квоте на текущей сети (`provider.quota`).
"""
import base64
import json
import os
import sys
import time
import urllib.request

BASE = 'http://127.0.0.1:49374'
TOKEN = os.environ.get('AI_SERVER_ENGINE_TOKEN', '')
TIMEOUT_MS = int(os.environ.get('ENGINE_PROBE_WAIT_MS', '45000'))
QUESTION = os.environ.get('ENGINE_PROBE_TEXT', 'Ответь одним словом: ок')


def call(path, method='GET', body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={
            'Authorization': 'Basic ' + base64.b64encode(('opencode:' + TOKEN).encode()).decode(),
            'Content-Type': 'application/json',
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or '{}')


def main():
    if not TOKEN:
        print(json.dumps({'ok': False, 'error': 'нет AI_SERVER_ENGINE_TOKEN'}))
        return 2
    try:
        models = [m['id'] for m in call('/api/model')['data'] if m.get('providerID') == 'opencode']
    except Exception as exc:  # сеть до движка
        print(json.dumps({'ok': False, 'error': f'движок недоступен: {exc}'}))
        return 2
    preferred = ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'big-pickle']
    forced = os.environ.get('ENGINE_PROBE_MODEL', '').strip()
    if forced:
        if forced not in models:
            print(json.dumps({'ok': False, 'error': f'модели {forced} нет в списке движка'}))
            return 2
        model = forced
    else:
        model = next((m for m in preferred if m in models), models[0] if models else None)
    if not model:
        print(json.dumps({'ok': False, 'error': 'движок не отдал ни одной модели'}))
        return 2

    session = call('/api/session', 'POST', {
        'title': 'exit probe',
        'model': {'providerID': 'opencode', 'id': model},
        'permissions': [],
    })
    sid = session['data']['id']
    try:
        call(f'/api/session/{sid}/prompt', 'POST', {'text': QUESTION}, timeout=120)
        deadline = time.time() + TIMEOUT_MS / 1000
        last_error = ''
        while time.time() < deadline:
            time.sleep(2)
            for message in call(f'/api/session/{sid}/message')['data']:
                if message.get('type') == 'idle' and message.get('outcome') == 'failed':
                    err = message.get('error') or {}
                    last_error = f"{err.get('type', 'error')}: {err.get('message', '')}".strip()
                if message.get('type') == 'assistant':
                    if message.get('error'):
                        err = message['error']
                        last_error = f"{err.get('type', 'error')}: {err.get('message', '')}".strip()
                    text = ''.join(
                        part.get('text', '') for part in (message.get('parts') or [])
                        if part.get('type') == 'text'
                    )
                    if text.strip():
                        print(json.dumps({'ok': True, 'model': model, 'text': text.strip()[:120]}))
                        return 0
                if last_error:
                    break
            if last_error:
                break
        print(json.dumps({'ok': False, 'model': model, 'error': last_error or 'нет ответа за отведённое время'}))
        return 1
    finally:
        try:
            call(f'/api/session/{sid}', 'DELETE', timeout=15)
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
