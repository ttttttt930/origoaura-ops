/**
 * L6 · data/crypto —— 浏览器端解密与指纹校验（ADR-06）
 *
 * 与管道 `packages/pipeline/src/snapshot/encrypt.ts` **参数逐位对齐**：
 *   KDF   PBKDF2-SHA256 / 150,000 次 / 16B salt / 派生 256bit
 *   加密  AES-256-GCM / 12B IV / 16B auth tag（tag 追加在密文尾部）
 * 若两边参数不一致，前端会直接解密失败 —— 这是刻意的"不兼容即报错"。
 *
 * 同时提供 SHA-256 指纹：与管道一样先做 stableStringify（键排序）再哈希，
 * 从而让"浏览器算出来的校验和"与"Node 算出来的校验和"逐字节相同。
 */

import { stableStringify, toHex } from '@origo/core';

/** 与管道 KDF_PARAMS 对齐；解密时以密文头部声明的参数为准（向前兼容） */
export const DEFAULT_KDF = {
  name: 'PBKDF2',
  hash: 'SHA-256',
  iterations: 150_000,
  keyLen: 32,
  saltBytes: 16,
} as const;

/** 信封里 KDF 声明的形状 */
export interface KdfDecl {
  name: string;
  hash: string;
  iterations: number;
  keyLen: number;
  saltBytes: number;
}

/** 加密快照信封（与管道 EncryptedPayload 结构一致） */
export interface EncryptedPayload {
  schemaVersion: string;
  generatedAt: string;
  kdf: KdfDecl;
  cipher: string;
  /** base64 */
  salt: string;
  /** base64 */
  iv: string;
  /** base64（密文 ‖ authTag） */
  payload: string;
  /** 明文指纹 */
  plainSha256: string;
  /** 分区校验和 */
  checksums: Record<string, string>;
}

/**
 * base64 → 字节。
 * 显式以 ArrayBuffer 为底层（而不是 `new Uint8Array(n)` 的默认 ArrayBufferLike），
 * 这样返回值能直接喂给 WebCrypto 的 BufferSource（TS 5.7 起这两者不再自动兼容）。
 */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** SHA-256 十六进制摘要（输入为字符串的 UTF-8 字节） */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

/** 对任意结构做"稳定指纹"：先键排序序列化，再 SHA-256 —— 与管道 sha256() 等价 */
export async function fingerprint(value: unknown): Promise<string> {
  return sha256Hex(stableStringify(value));
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, kdf: KdfDecl): Promise<CryptoKey> {
  if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') {
    throw new DecryptError('corrupt', `不支持的 KDF：${kdf.name}/${kdf.hash}，本前端只实现 PBKDF2-SHA256。`);
  }
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: kdf.iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

/**
 * 用口令解密快照，并逐项校验：
 *   1. AES-GCM 的 auth tag（密文被篡改 / 口令不对 → 抛错）；
 *   2. 明文指纹 plainSha256（传输截断）；
 *   3. 各分区 checksums（跨端口径一致性）。
 *
 * @throws DecryptError —— 区分「口令错误」与「数据损坏」，便于界面给出正确提示
 */
export class DecryptError extends Error {
  readonly kind: 'password' | 'corrupt' | 'checksum';
  constructor(kind: 'password' | 'corrupt' | 'checksum', message: string) {
    super(message);
    this.name = 'DecryptError';
    this.kind = kind;
  }
}

export interface DecryptResult {
  /** 明文（已 JSON.parse） */
  plain: unknown;
  /** 实际使用的 KDF 参数（来自信封） */
  kdf: KdfDecl;
  /** 各分区校验和是否逐一匹配 */
  checksumResults: { key: string; expected: string; actual: string; ok: boolean }[];
  allChecksumsOk: boolean;
}

export async function decryptSnapshot(enc: EncryptedPayload, password: string): Promise<DecryptResult> {
  if (enc.cipher !== 'AES-256-GCM') {
    throw new DecryptError('corrupt', `不支持的加密算法：${enc.cipher}`);
  }
  const salt = base64ToBytes(enc.salt);
  const iv = base64ToBytes(enc.iv);
  const blob = base64ToBytes(enc.payload);
  if (blob.length <= 16) {
    throw new DecryptError('corrupt', '密文长度异常（不足一个 GCM tag），文件可能被截断。');
  }

  let key: CryptoKey;
  try {
    key = await deriveKey(password, salt, enc.kdf ?? DEFAULT_KDF);
  } catch (e) {
    throw new DecryptError('corrupt', `密钥派生失败：${(e as Error).message}`);
  }

  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, blob);
  } catch {
    // GCM 认证失败：绝大多数情况是口令不对，也可能是密文被改
    throw new DecryptError(
      'password',
      '解密失败：口令不正确，或密文已被篡改。请核对解锁口令。',
    );
  }

  const plainBytes = new Uint8Array(plainBuf);
  const digest = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', plainBytes)));
  if (enc.plainSha256 && digest !== enc.plainSha256) {
    throw new DecryptError(
      'corrupt',
      `解密成功但明文指纹不符（期望 ${enc.plainSha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）：数据在传输中被截断或修改。`,
    );
  }

  let plain: unknown;
  try {
    plain = JSON.parse(new TextDecoder().decode(plainBytes));
  } catch {
    throw new DecryptError('corrupt', '解密后的内容不是合法 JSON，文件已损坏。');
  }

  // ---- 分区校验和复核 ----
  const obj = plain as Record<string, unknown>;
  const checksumResults: DecryptResult['checksumResults'] = [];
  for (const [key2, expected] of Object.entries(enc.checksums ?? {})) {
    const actual = await fingerprint(obj[key2]);
    checksumResults.push({ key: key2, expected, actual, ok: actual === expected });
  }
  const allChecksumsOk = checksumResults.every((r) => r.ok);

  return { plain, kdf: enc.kdf ?? DEFAULT_KDF, checksumResults, allChecksumsOk };
}
