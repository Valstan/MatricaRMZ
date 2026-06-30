import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LedgerStore, generateLedgerKeyPair, type LedgerSignedTx, type LedgerTxPayload } from '@matricarmz/ledger';

function makeTx(id: string): LedgerSignedTx {
  return {
    type: 'upsert',
    table: 'entities',
    row: { id },
    row_id: id,
    actor: { userId: 'sys', username: 'sys', role: 'sys' },
    ts: Date.now(),
    seq: 0,
    tx_id: `${id}-${Date.now()}`,
    signature: '',
    public_key: '',
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-store-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('LedgerStore atomic writes', () => {
  it('round-trips state/index/checkpoint and leaves no temp or lock files behind', () => {
    const store = new LedgerStore(dir);

    store.appendBlock([makeTx('a'), makeTx('b')]);
    store.appendBlock([makeTx('c')]);

    const index = store.loadIndex();
    expect(index.lastHeight).toBe(2);

    const state = store.loadState();
    expect(Object.keys(state.tables.entities).sort()).toEqual(['a', 'b', 'c']);

    const checkpoint = store.buildCheckpoint();
    expect(checkpoint.lastHeight).toBe(2);
    expect(store.loadCheckpoint()?.stateHash).toBe(checkpoint.stateHash);

    // No half-written temp files and no leaked advisory lock.
    const rootEntries = readdirSync(dir);
    expect(rootEntries.some((f) => f.includes('.tmp-'))).toBe(false);
    expect(rootEntries).not.toContain('.ledger.lock');
    const blockEntries = readdirSync(join(dir, 'blocks'));
    expect(blockEntries.every((f) => f.endsWith('.json'))).toBe(true);
    expect(blockEntries).toHaveLength(2);
  });

  it('appendBlock nests writes under one lock without deadlocking', () => {
    const store = new LedgerStore(dir);
    // checkpointEvery=1 forces buildCheckpoint() (a nested withLock) on every append.
    const prev = process.env.MATRICA_LEDGER_CHECKPOINT_EVERY_BLOCKS;
    process.env.MATRICA_LEDGER_CHECKPOINT_EVERY_BLOCKS = '1';
    try {
      for (let i = 0; i < 5; i += 1) store.appendBlock([makeTx(`row-${i}`)]);
    } finally {
      if (prev === undefined) delete process.env.MATRICA_LEDGER_CHECKPOINT_EVERY_BLOCKS;
      else process.env.MATRICA_LEDGER_CHECKPOINT_EVERY_BLOCKS = prev;
    }
    expect(store.loadIndex().lastHeight).toBe(5);
    expect(store.loadCheckpoint()?.lastHeight).toBe(5);
    expect(readdirSync(dir)).not.toContain('.ledger.lock');
  });

  it('steals a stale lock left by a crashed writer', () => {
    const store = new LedgerStore(dir);
    store.appendBlock([makeTx('seed')]);

    // Simulate a crashed holder: lock file with an old timestamp and a dead pid.
    writeFileSync(join(dir, '.ledger.lock'), JSON.stringify({ pid: 999_999_999, ts: Date.now() - 60_000 }));

    // Must steal the stale lock and complete rather than block until timeout.
    const start = Date.now();
    store.appendBlock([makeTx('after-crash')]);
    expect(Date.now() - start).toBeLessThan(5_000);

    expect(store.loadIndex().lastHeight).toBe(2);
    expect(Object.keys(store.loadState().tables.entities).sort()).toEqual(['after-crash', 'seed']);
  });
});

describe('LedgerStore.signAndAppend', () => {
  function payload(id: string): LedgerTxPayload {
    return {
      type: 'upsert',
      table: 'entities',
      row: { id },
      row_id: id,
      actor: { userId: 'sys', username: 'sys', role: 'sys' },
      ts: Date.now(),
    };
  }

  it('allocates contiguous seqs and appends in one step', () => {
    const store = new LedgerStore(dir);
    const keys = generateLedgerKeyPair();

    const first = store.signAndAppend([payload('a'), payload('b')], keys.privateKeyPem, keys.publicKeyPem);
    expect(first.signed.map((t) => t.seq)).toEqual([1, 2]);
    expect(first.block.height).toBe(1);

    const second = store.signAndAppend([payload('c')], keys.privateKeyPem, keys.publicKeyPem);
    expect(second.signed.map((t) => t.seq)).toEqual([3]);
    expect(second.block.height).toBe(2);

    expect(store.loadIndex().lastSeq).toBe(3);
    expect(store.verifyTxs(first.signed)).toBe(true);
  });
});

describe('LedgerStore cross-process safety', () => {
  function runWorker(workerPath: string, count: number, tag: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', workerPath, dir, String(count), tag], {
        cwd: process.cwd(),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`worker ${tag} exited ${code}: ${stderr}`));
      });
    });
  }

  it('serializes concurrent appends from separate processes without corruption', async () => {
    const workerPath = resolve(process.cwd(), 'src/tests/fixtures/ledgerConcurrentWorker.ts');
    const workers = 4;
    const perWorker = 20;
    const total = workers * perWorker;

    await Promise.all(
      Array.from({ length: workers }, (_unused, k) => runWorker(workerPath, perWorker, `w${k}`)),
    );

    const store = new LedgerStore(dir);
    const blocks = store.listBlocksSince(0, total + 10);

    // Every append produced exactly one block — no clobbered/lost writes.
    expect(blocks).toHaveLength(total);

    // Heights are unique and contiguous 1..total (no two processes wrote the same height).
    const heights = blocks.map((b) => b.height).sort((a, b) => a - b);
    expect(new Set(heights).size).toBe(total);
    expect(heights[0]).toBe(1);
    expect(heights[heights.length - 1]).toBe(total);
    expect(store.loadIndex().lastHeight).toBe(total);

    // state.json reflects every block's row — proves no lost-update on the read-modify-write.
    expect(Object.keys(store.loadState().tables.entities)).toHaveLength(total);

    // No leaked lock or temp files after all processes finished.
    const rootEntries = readdirSync(dir);
    expect(rootEntries).not.toContain('.ledger.lock');
    expect(rootEntries.some((f) => f.includes('.tmp-'))).toBe(false);
  }, 60_000);

  it('allocates unique contiguous seqs across processes via signAndAppend', async () => {
    const workerPath = resolve(process.cwd(), 'src/tests/fixtures/ledgerSeqWorker.ts');
    const workers = 4;
    const perWorker = 15;
    const total = workers * perWorker;

    await Promise.all(
      Array.from({ length: workers }, (_unused, k) => runWorker(workerPath, perWorker, `s${k}`)),
    );

    const store = new LedgerStore(dir);
    const txs = store.listTxsSince(0, total + 10);
    expect(txs).toHaveLength(total);

    // seqs must be exactly 1..total — no duplicates (the race) and no gaps.
    const seqs = txs.map((t) => t.seq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(total);
    expect(seqs[0]).toBe(1);
    expect(seqs[seqs.length - 1]).toBe(total);
    expect(store.loadIndex().lastSeq).toBe(total);
  }, 60_000);
});
