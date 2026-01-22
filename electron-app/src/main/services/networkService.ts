import { net, session } from 'electron';
import { EventEmitter } from 'node:events';
import dns from 'node:dns';

type NetworkState = {
  online: boolean;
  lastChangeAt: number;
  lastError: string | null;
};

const emitter = new EventEmitter();
let state: NetworkState = {
  online: net.isOnline(),
  lastChangeAt: Date.now(),
  lastError: null,
};

let monitorStarted = false;

function updateState(next: Partial<NetworkState>) {
  const prev = state;
  state = { ...state, ...next };
  if (prev.online !== state.online) {
    state.lastChangeAt = Date.now();
    emitter.emit('change', { ...state });
  }
}

async function probe(url: string, timeoutMs: number) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const r = await net.fetch(url, { method: 'GET', signal: ac.signal as any });
    return r.ok;
  } catch (e) {
    state.lastError = String(e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function initNetworkService(opts?: { probeUrl?: string; intervalMs?: number }) {
  try {
    await session.defaultSession.setProxy({ mode: 'system' });
  } catch {
    // ignore proxy setup errors
  }

  try {
    dns.setDefaultResultOrder?.('ipv4first');
  } catch {
    // ignore dns order errors
  }

  if (monitorStarted) return;
  monitorStarted = true;

  const intervalMs = Math.max(2000, opts?.intervalMs ?? 8000);
  const probeUrl = opts?.probeUrl ?? '';

  const tick = async () => {
    let online = net.isOnline();
    if (online && probeUrl) {
      online = await probe(probeUrl, 3500);
    }
    updateState({ online, lastError: online ? null : state.lastError });
  };

  void tick();
  setInterval(() => void tick(), intervalMs);
}

export function getNetworkState(): NetworkState {
  return { ...state };
}

export function onNetworkChange(handler: (next: NetworkState) => void): () => void {
  emitter.on('change', handler);
  return () => emitter.off('change', handler);
}
