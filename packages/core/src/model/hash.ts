/**
 * L5 · model/hash —— 稳定序列化（跨端一致性的基础）
 *
 * 为什么放在内核：管道用 node:crypto 算指纹、浏览器用 WebCrypto 算指纹，
 * **摘要算法是平台能力，但"被摘要的字节"必须是同一串**。
 * 若两端各写一份 JSON.stringify，键序稍有差别就会导致"校验和不一致"的误报，
 * 让人开始不信任校验和本身。故这里只定义序列化，不算摘要。
 */

/**
 * 键名升序的确定性序列化。同样的内容永远得到同样的字符串。
 * 刻意不用 JSON.stringify 的默认行为：它依赖属性的插入顺序。
 */
export function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v as number) ? String(v) : 'null';
  if (t === 'boolean' || t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (t === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return 'null';
}

/** 十六进制摘要（小写） */
export function toHex(buf: Uint8Array): string {
  let out = '';
  for (const b of buf) out += b.toString(16).padStart(2, '0');
  return out;
}
