import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LedgerBlock, LedgerSignedTx, LedgerState, LedgerTxPayload } from './types.js';
import { emptyLedgerState } from './types.js';
import { applyTxs } from './state.js';
import { hashBlockContent, hashTxPayload, signTxPayload, verifyTxPayload } from './crypto.js';

type LedgerIndex = {
  lastHeight: number;
  lastHash: string;
  lastSeq: number;
};

const INDEX_FILE = 'index.json';
const STATE_FILE = 'state.json';

export class LedgerStore {
  private readonly rootDir: string;
  private readonly blocksDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.blocksDir = join(rootDir, 'blocks');
    mkdirSync(this.rootDir, { recursive: true });
    mkdirSync(this.blocksDir, { recursive: true });
  }

  loadIndex(): LedgerIndex {
    const indexPath = join(this.rootDir, INDEX_FILE);
    if (!existsSync(indexPath)) {
      return { lastHeight: 0, lastHash: 'GENESIS', lastSeq: 0 };
    }
    return JSON.parse(readFileSync(indexPath, 'utf8')) as LedgerIndex;
  }

  saveIndex(index: LedgerIndex) {
    const indexPath = join(this.rootDir, INDEX_FILE);
    writeFileSync(indexPath, JSON.stringify(index, null, 2));
  }

  loadState(): LedgerState {
    const statePath = join(this.rootDir, STATE_FILE);
    if (!existsSync(statePath)) return emptyLedgerState();
    return JSON.parse(readFileSync(statePath, 'utf8')) as LedgerState;
  }

  saveState(state: LedgerState) {
    const statePath = join(this.rootDir, STATE_FILE);
    writeFileSync(statePath, JSON.stringify(state, null, 2));
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

  verifyTxs(txs: LedgerSignedTx[]): boolean {
    return txs.every((tx) =>
      verifyTxPayload(
        {
          type: tx.type,
          table: tx.table,
          row: tx.row,
          row_id: tx.row_id,
          actor: tx.actor,
          ts: tx.ts,
        },
        tx.signature,
        tx.public_key,
      ),
    );
  }

  appendBlock(txs: LedgerSignedTx[]): LedgerBlock {
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
    writeFileSync(blockPath, JSON.stringify(block, null, 2));
    this.saveIndex({ lastHeight: height, lastHash: hash, lastSeq: txs.at(-1)?.seq ?? index.lastSeq });
    const state = this.loadState();
    this.saveState(applyTxs(state, txs));
    return block;
  }

  appendRemoteBlock(block: LedgerBlock): LedgerBlock {
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
    writeFileSync(blockPath, JSON.stringify(block, null, 2));
    this.saveIndex({ lastHeight: block.height, lastHash: block.hash, lastSeq: block.txs.at(-1)?.seq ?? index.lastSeq });
    const state = this.loadState();
    this.saveState(applyTxs(state, block.txs));
    return block;
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
