// DeepSeek с машины оператора (D-243, решение владельца № 2; ключ — клиентский, D-244).
//
// Это ВТОРОЕ звено клиентской цепочки: локальный MiniMax не справился — клиент зовёт
// провайдера сам, своим ключом (свой баланс и своя ротация), а не серверный.
//
// Эндпойнт Anthropic-совместимый — тот же контракт, что у сервера (`llmProvider.ts`),
// поэтому модель зовётся `deepseek-flash`.
//
// ⚠️ Эндпойнт режется с РФ-IP (`docs/ai-chat/DIRECT.md`): с машины парка запрос может
// не дойти. Тогда звено честно отказывает, и вопрос уходит дальше по цепочке.

export const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
export const DEEPSEEK_WIRE_MODEL = 'deepseek-flash';

export type DeepSeekResult = { ok: true; answer: string } | { ok: false; reason: string; message: string };

export type DeepSeekCall = {
  apiKey: string;
  question: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

/** Позвать DeepSeek с машины оператора. */
export async function callDeepSeek(call: DeepSeekCall): Promise<DeepSeekResult> {
  if (!call.apiKey.trim()) {
    return { ok: false, reason: 'no_key', message: 'клиентский ключ DeepSeek не задан' };
  }
  const fetchImpl = call.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs ?? 120_000);
  try {
    const response = await fetchImpl(`${DEEPSEEK_ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': call.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: DEEPSEEK_WIRE_MODEL,
        max_tokens: call.maxTokens ?? 4000,
        messages: [{ role: 'user', content: call.question }],
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        reason: response.status === 403 || response.status === 401 ? 'forbidden' : 'http_error',
        message: `DeepSeek ответил ${response.status}: ${body.slice(0, 200)}`,
      };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, reason: 'bad_response', message: 'DeepSeek ответил неразборчивым JSON' };
    }
    const text = (parsed?.content ?? [])
      .filter((part: any) => part?.type === 'text')
      .map((part: any) => String(part.text ?? ''))
      .join('\n')
      .trim();
    if (!text) {
      return { ok: false, reason: 'empty_response', message: 'DeepSeek ответил пустотой' };
    }
    return { ok: true, answer: text };
  } catch (e) {
    return { ok: false, reason: 'network', message: `DeepSeek недоступен: ${String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}
