import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LedgerBlock, LedgerSignedTx, LedgerState, LedgerTxPayload } from './types.js';
import { emptyLedgerState } from './types.js';
import { applyTxs, computeLedgerStateHashes } from './state.js';
import { hashBlockContent, hashTxPayload, signTxPayload, verifyTxPayload } from './crypto.js';

type LedgerIndex = {
  lastHeight: number;
  lastHash: string;
  lastSeq: number;
};

type LedgerCheckpoint = {
  version: 1;
  createdAt: number;
  lastHeight: number;
  lastSeq: number;
  stateHash: string;
  tableHashes: Record<string, string>;
};

const INDEX_FILE = 'index.json';
const STATE_FILE = 'state.json';
const CHECKPOINT_FILE = 'checkpoint.json';
const LOCK_FILE = '.ledger.lock';

// A stale lock left by a crashed writer is stolen after this window; pid-liveness
// allows an immediate steal when the holder is a dead local process.
const LOCK_STALE_MS = 15_000;
// Bounded so a genuinely wedged lock surfaces as an error instead of an infinite hang.
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 25;

// Single shared buffer for synchronous sleeps (Atomics.wait blocks without busy-spin).
const SLEEP_SAB = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_SAB, 0, 0, ms);
}

let tmpCounter = 0;

/**
 * Crash-atomic write: data lands in a per-process temp file, is flushed to disk,
 * then renamed over the target. Readers therefore always observe a complete file
 * (the old one or the new one) — never a half-written one. This is the fix for the
 * `SyntaxError: Unterminated string in JSON` crashes seen when a maintenance script
 * read state.json mid-write of a live service.
 */
function writeFileAtomic(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${(tmpCounter += 1)}`;
  const fd = openSync(tmpPath, 'w');
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameWithRetry(tmpPath, filePath);
}

function renameWithRetry(from: string, to: string): void {
  // POSIX rename is atomic. On Windows it can transiently fail with EPERM/EACCES
  // while a reader holds the destination open; retry briefly before giving up.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EEXIST') throw err;
      sleepSync(20);
    }
  }
  throw lastErr;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = exists but not signalable by us (alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class LedgerStore {
  private readonly rootDir: string;
  private readonly blocksDir: string;
  private readonly lockPath: string;
  private lockFd: number | null = null;
  private lockDepth = 0;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.blocksDir = join(rootDir, 'blocks');
    this.lockPath = join(rootDir, LOCK_FILE);
    mkdirSync(this.rootDir, { recursive: true });
    mkdirSync(this.blocksDir, { recursive: true });
  }

  /**
   * Run `fn` while holding a cross-process advisory lock on the ledger directory,
   * so a maintenance script and a live service cannot interleave a read-modify-write
   * (e.g. two appendBlock calls reading the same lastHeight and clobbering each other).
   * Reentrant within the instance: appendBlock -> saveIndex/saveState/buildCheckpoint
   * nest under a single held lock. Reads are intentionally NOT locked — atomic writes
   * already guarantee they never observe a torn file.
   */
  private withLock<T>(fn: () => T): T {
    const reentrant = this.lockDepth > 0;
    if (reentrant) {
      this.lockDepth += 1;
    } else {
      this.acquireLock();
    }
    try {
      return fn();
    } finally {
      if (reentrant) {
        this.lockDepth -= 1;
      } else {
        this.releaseLock();
      }
    }
  }

  private acquireLock(): void {
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        this.lockFd = fd;
        this.lockDepth = 1;
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // EEXIST is the normal "already held" signal. On Windows the create can
        // instead transiently fail with EPERM/EACCES/EBUSY when the lock file is in
        // a delete-pending state (a releasing writer's unlink not yet finalized) or
        // briefly held by an AV/indexer — those are contention, not errors, so retry
        // within the deadline rather than crashing the writer. Only a genuine EEXIST
        // means the file is readable enough to assess for stale-lock stealing.
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err;
        if (code === 'EEXIST' && this.tryStealStaleLock()) continue;
        if (Date.now() >= deadline) {
          throw new Error(`ledger_lock_timeout: ${this.lockPath} held longer than ${LOCK_ACQUIRE_TIMEOUT_MS}ms`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
  }

  private tryStealStaleLock(): boolean {
    let info: { pid?: number; ts?: number } | null = null;
    try {
      info = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid?: number; ts?: number };
    } catch {
      // Unreadable/garbage lock content — fall through to mtime-based staleness.
      info = null;
    }
    const now = Date.now();
    let stale = false;
    if (info && typeof info.ts === 'number') {
      if (now - info.ts > LOCK_STALE_MS) stale = true;
      else if (typeof info.pid === 'number' && !isProcessAlive(info.pid)) stale = true;
    } else {
      try {
        if (now - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) stale = true;
      } catch {
        // Lock vanished between checks — let the caller retry openSync.
        return true;
      }
    }
    if (!stale) return false;
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Another waiter stole it first — retrying openSync is correct either way.
    }
    return true;
  }

  private releaseLock(): void {
    this.lockDepth = 0;
    if (this.lockFd != null) {
      try {
        closeSync(this.lockFd);
      } catch {
        // Best-effort close; the unlink below is what releases the lock.
      }
      this.lockFd = null;
    }
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Already removed (e.g. stale-stolen) — nothing to do.
    }
  }

  loadIndex(): LedgerIndex {
    const indexPath = join(this.rootDir, INDEX_FILE);
    if (!existsSync(indexPath)) {
      return { lastHeight: 0, lastHash: 'GENESIS', lastSeq: 0 };
    }
    return JSON.parse(readFileSync(indexPath, 'utf8')) as LedgerIndex;
  }

  saveIndex(index: LedgerIndex) {
    this.withLock(() => writeFileAtomic(join(this.rootDir, INDEX_FILE), JSON.stringify(index, null, 2)));
  }

  loadState(): LedgerState {
    const statePath = join(this.rootDir, STATE_FILE);
    if (!existsSync(statePath)) return emptyLedgerState();
    return JSON.parse(readFileSync(statePath, 'utf8')) as LedgerState;
  }

  saveState(state: LedgerState) {
    this.withLock(() => writeFileAtomic(join(this.rootDir, STATE_FILE), JSON.stringify(state, null, 2)));
  }

  loadCheckpoint(): LedgerCheckpoint | null {
    const checkpointPath = join(this.rootDir, CHECKPOINT_FILE);
    if (!existsSync(checkpointPath)) return null;
    return JSON.parse(readFileSync(checkpointPath, 'utf8')) as LedgerCheckpoint;
  }

  saveCheckpoint(checkpoint: LedgerCheckpoint) {
    this.withLock(() => writeFileAtomic(join(this.rootDir, CHECKPOINT_FILE), JSON.stringify(checkpoint, null, 2)));
  }

  buildCheckpoint(): LedgerCheckpoint {
    return this.withLock(() => {
      const state = this.loadState();
      const index = this.loadIndex();
      const hashes = computeLedgerStateHashes(state);
      const checkpoint: LedgerCheckpoint = {
        version: 1,
        createdAt: Date.now(),
        lastHeight: index.lastHeight,
        lastSeq: index.lastSeq,
        stateHash: hashes.stateHash,
        tableHashes: hashes.tableHashes,
      };
      this.saveCheckpoint(checkpoint);
      return checkpoint;
    });
  }

  signTxs(payloads: LedgerTxPayload[], privateKeyPem: string, publicKeyPem: string): LedgerSignedTx[] {
    const index = this.loadIndex();
    let seq = index.lastSeq;
    return payloads.map((payload) => {
      const txPayload = { ...payload };
      const signature = signTxPayload(txPayload, privateKeyPem);
      const txId = hashTxPayload(txPayload);
      seq += 1;
      return {
        ...txPayload,
        seq,
        tx_id: txId,
        signature,
        public_key: publicKeyPem,
      };
    });
  }

  /**
   * Allocate seqs and append in one locked step. signTxs reads lastSeq from the
   * index; doing it under the same (reentrant) lock as appendBlock makes seq
   * allocation atomic with the append, so two processes can't both sign against
   * the same lastSeq and emit duplicate seqs. Encryption stays outside the lock
   * (the caller encrypts payloads before calling this).
   */
  signAndAppend(
    payloads: LedgerTxPayload[],
    privateKeyPem: string,
    publicKeyPem: string,
  ): { block: LedgerBlock; signed: LedgerSignedTx[] } {
    return this.withLock(() => {
      const signed = this.signTxs(payloads, privateKeyPem, publicKeyPem);
      const block = this.appendBlock(signed);
      return { block, signed };
    });
  }

  verifyTxs(txs: LedgerSignedTx[]): boolean {
    return txs.every((tx) =>
      verifyTxPayload(
        {
          type: tx.type,
          table: tx.table,
          ...(tx.row != null ? { row: tx.row } : {}),
          ...(tx.row_id != null ? { row_id: tx.row_id } : {}),
          actor: tx.actor,
          ts: tx.ts,
        },
        tx.signature,
        tx.public_key,
      ),
    );
  }

  appendBlock(txs: LedgerSignedTx[]): LedgerBlock {
    return this.withLock(() => {
      const index = this.loadIndex();
      const createdAt = Date.now();
      const height = index.lastHeight + 1;
      const prevHash = index.lastHash;
      const txIds = txs.map((tx) => tx.tx_id);
      const hash = hashBlockContent(prevHash, createdAt, txIds);
      const block: LedgerBlock = {
        height,
        prev_hash: prevHash,
        created_at: createdAt,
        txs,
        hash,
      };
      const blockPath = join(this.blocksDir, `${String(height).padStart(8, '0')}.json`);
      writeFileAtomic(blockPath, JSON.stringify(block, null, 2));
      this.saveIndex({ lastHeight: height, lastHash: hash, lastSeq: txs.at(-1)?.seq ?? index.lastSeq });
      const state = this.loadState();
      this.saveState(applyTxs(state, txs));
      const checkpointEvery = Math.max(1, Number(process.env.MATRICA_LEDGER_CHECKPOINT_EVERY_BLOCKS ?? 100));
      if (height % checkpointEvery === 0) this.buildCheckpoint();
      return block;
    });
  }

  appendRemoteBlock(block: LedgerBlock): LedgerBlock {
    return this.withLock(() => {
      const index = this.loadIndex();
      if (block.height !== index.lastHeight + 1) {
        throw new Error(`ledger_out_of_order: expected=${index.lastHeight + 1} got=${block.height}`);
      }
      const expectedHash = hashBlockContent(block.prev_hash, block.created_at, block.txs.map((tx) => tx.tx_id));
      if (expectedHash !== block.hash) {
        throw new Error('ledger_block_hash_mismatch');
      }
      if (!this.verifyTxs(block.txs)) {
        throw new Error('ledger_tx_signature_invalid');
      }
      const blockPath = join(this.blocksDir, `${String(block.height).padStart(8, '0')}.json`);
      writeFileAtomic(blockPath, JSON.stringify(block, null, 2));
      this.saveIndex({ lastHeight: block.height, lastHash: block.hash, lastSeq: block.txs.at(-1)?.seq ?? index.lastSeq });
      const state = this.loadState();
      this.saveState(applyTxs(state, block.txs));
      const checkpointEvery = Math.max(1, Number(process.env.MATRICA_LEDGER_CHECKPOINT_EVERY_BLOCKS ?? 100));
      if (block.height % checkpointEvery === 0) this.buildCheckpoint();
      return block;
    });
  }

  listBlocksSince(height: number, limit: number): LedgerBlock[] {
    const files = readdirSync(this.blocksDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const result: LedgerBlock[] = [];
    for (const file of files) {
      const block = JSON.parse(readFileSync(join(this.blocksDir, file), 'utf8')) as LedgerBlock;
      if (block.height > height) result.push(block);
      if (result.length >= limit) return result;
    }
    return result;
  }

  listTxsSince(seq: number, limit: number): LedgerSignedTx[] {
    const files = readdirSync(this.blocksDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const result: LedgerSignedTx[] = [];
    for (const file of files) {
      const block = JSON.parse(readFileSync(join(this.blocksDir, file), 'utf8')) as LedgerBlock;
      for (const tx of block.txs) {
        if (tx.seq > seq) result.push(tx);
        if (result.length >= limit) return result;
      }
    }
    return result;
  }
}
