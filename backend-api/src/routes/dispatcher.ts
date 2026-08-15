// Диспетчер — расширяемый координатор экосистемы MatricaRMZ. Сегодня он ведёт
// обновления (см. updateDispatcherService.ts); в будущем сюда встанут советы клиентам
// по ошибкам и консультации нейросети (ИИваныч/DeepSeek, D-024). Новые версии
// программы разговаривают с ним при каждом включении (/dispatcher/checkin).
//
// Маршруты ПУБЛИЧНЫЕ, как и остальные download/metadata-маршруты /updates: заглушке и
// свежеустановленному, ещё не залогиненному клиенту нужен план обновления до любой
// авторизации. Персональных данных здесь нет — только версии и имена файлов.

import { Router } from 'express';

import { logInfo } from '../utils/logger.js';
import { getUpdatePlan } from '../services/updateDispatcherService.js';

export const dispatcherRouter = Router();

function planUrls(base: string, latest: { fileName: string; blockmapFileName?: string }) {
  return {
    url: `${base}/updates/file/${encodeURIComponent(latest.fileName)}`,
    ...(latest.blockmapFileName
      ? { blockmapUrl: `${base}/updates/file/${encodeURIComponent(latest.blockmapFileName)}` }
      : {}),
  };
}

// План обновления: «я на версии X — что мне делать?». Им пользуется заглушка
// (current=stub) и может пользоваться любой клиент.
dispatcherRouter.get('/update-plan', async (req, res) => {
  try {
    const current = String(req.query.current ?? '').trim();
    const plan = await getUpdatePlan(current);
    if (plan.action === 'none') return res.json({ ok: false, error: plan.reason });
    const base = `${req.protocol}://${req.get('host')}`;
    return res.json({
      ok: true,
      action: plan.action,
      current: plan.current,
      latest: { ...plan.latest, ...planUrls(base, plan.latest) },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Приветствие клиента при включении: сообщает версию, получает план обновления.
// Расширяемая точка — в ответе зарезервировано поле advice (пока всегда null).
dispatcherRouter.post('/checkin', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const version = String(body.version ?? '').trim();
    const hostname = String(body.hostname ?? '').trim();
    const platform = String(body.platform ?? '').trim();
    logInfo(`dispatcher checkin: version=${version || '?'} host=${hostname || '?'} platform=${platform || '?'}`);
    const plan = await getUpdatePlan(version);
    const base = `${req.protocol}://${req.get('host')}`;
    return res.json({
      ok: true,
      ...(plan.action === 'none'
        ? { action: 'none' as const }
        : { action: plan.action, latest: { ...plan.latest, ...planUrls(base, plan.latest) } }),
      advice: null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
