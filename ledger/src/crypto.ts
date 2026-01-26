import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { LedgerTxPayload } from './types.js';
import { canonicalizeTxPayload } from './types.js';

export type LedgerKeyPair = {
  publicKeyPem: string;
  privateKeyPem: string;
};

export function generateLedgerKeyPair(): LedgerKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function signTxPayload(payload: LedgerTxPayload, privateKeyPem: string): string {
  const data = Buffer.from(canonicalizeTxPayload(payload));
  return sign(null, data, privateKeyPem).toString('base64');
}

export function verifyTxPayload(payload: LedgerTxPayload, signature: string, publicKeyPem: string): boolean {
  const data = Buffer.from(canonicalizeTxPayload(payload));
  return verify(null, data, publicKeyPem, Buffer.from(signature, 'base64'));
}

export function hashTxPayload(payload: LedgerTxPayload): string {
  return createHash('sha256').update(canonicalizeTxPayload(payload)).digest('hex');
}

export function hashBlockContent(prevHash: string, createdAt: number, txIds: string[]): string {
  const raw = `${prevHash}|${createdAt}|${txIds.join(',')}`;
  return createHash('sha256').update(raw).digest('hex');
}
