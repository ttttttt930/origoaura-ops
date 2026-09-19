/**
 * L4 · snapshot/encrypt —— AES-256-GCM 加密封装（ADR-06）
 *
 * 参数与现行站点保持一致，避免前后端解密口径分裂：
 *   KDF  PBKDF2-SHA256 / 150,000 次 / 16B salt / 派生 256bit
 *   加密 AES-256-GCM / 12B IV / 16B auth tag
 *
 * 【必须如实说明的局限】密钥内置于前端产物，加密只防"明文直接抓取"，
 * **不是权限隔离**。真权限在 V12 解决。文档与界面都必须保留这句话。
 */

import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { Snapshot } from '@origo/core';

export const KDF_PARAMS = {
  name: 'PBKDF2',
  hash: 'SHA-256',
  iterations: 150_000,
  keyLen: 32,
  saltBytes: 16,
} as const;

export const CIPHER = {
  name: 'AES-256-GCM',
  ivBytes: 12,
  tagBytes: 16,
} as const;

export interface EncryptedPayload {
  schemaVersion: string;
  generatedAt: string;
  kdf: typeof KDF_PARAMS;
  cipher: string;
  /** base64 */
  salt: string;
  /** base64 */
  iv: string;
  /** base64（密文 || authTag） */
  payload: string;
  /** 明文指纹，便于前端解密后校验完整性 */
  plainSha256: string;
  /** 校验和（与快照信封内一致） */
  checksums: Record<string, string>;
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, KDF_PARAMS.iterations, KDF_PARAMS.keyLen, 'sha256');
}

/** 加密快照。salt / iv 每次随机 —— 同一份数据每次产出不同密文是正确的。 */
export function encryptSnapshot(snapshot: Snapshot, password: string): EncryptedPayload {
  const plain = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const salt = randomBytes(KDF_PARAMS.saltBytes);
  const iv = randomBytes(CIPHER.ivBytes);
  const key = deriveKey(password, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([ct, tag]);

  return {
    schemaVersion: snapshot.schemaVersion,
    generatedAt: snapshot.generatedAt,
    kdf: KDF_PARAMS,
    cipher: CIPHER.name,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    payload: payload.toString('base64'),
    plainSha256: createHash('sha256').update(plain).digest('hex'),
    checksums: snapshot.checksums,
  };
}

/** 解密（供测试与 CLI doctor 自检使用；前端有等价的 WebCrypto 实现） */
export function decryptPayload(enc: EncryptedPayload, password: string): Snapshot {
  const salt = Buffer.from(enc.salt, 'base64');
  const iv = Buffer.from(enc.iv, 'base64');
  const buf = Buffer.from(enc.payload, 'base64');
  const tag = buf.subarray(buf.length - CIPHER.tagBytes);
  const ct = buf.subarray(0, buf.length - CIPHER.tagBytes);
  const key = deriveKey(password, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  const snapshot = JSON.parse(plain.toString('utf8')) as Snapshot;

  const digest = createHash('sha256').update(plain).digest('hex');
  if (digest !== enc.plainSha256) {
    throw new Error('解密成功但指纹不符：密文可能在传输中被截断或篡改。');
  }
  return snapshot;
}
