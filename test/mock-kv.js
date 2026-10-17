// 内存版 KV，尽量贴着 EdgeOne KV 的真实行为，避免本地跑通、线上挂掉：
// - key 只允许数字、字母、下划线，长度 ≤ 512B（超限直接抛错）
// - list 的 cursor 是「下一页的第一个 key」，按字典序分页，limit 上限 256
const KEY_PATTERN = /^[0-9A-Za-z_]+$/;
const MAX_KEY_BYTES = 512;
const MAX_LIMIT = 256;

function assertKey(key) {
  const k = String(key);
  if (!KEY_PATTERN.test(k)) throw new Error(`KV key 非法（仅支持数字、字母、下划线）: ${k}`);
  if (new TextEncoder().encode(k).length > MAX_KEY_BYTES) throw new Error(`KV key 超长（≤ 512B）: ${k}`);
  return k;
}

export function createMockKV() {
  const map = new Map();
  return {
    store: map,
    async get(key, opts) {
      const v = map.get(assertKey(key));
      if (v === undefined) return null;
      if (opts && (opts === 'json' || opts.type === 'json')) {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key, value) { map.set(assertKey(key), value); },
    async delete(key) { map.delete(assertKey(key)); },
    async list({ prefix = '', limit = MAX_LIMIT, cursor } = {}) {
      const size = Math.min(limit || MAX_LIMIT, MAX_LIMIT);
      const snapshot = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? snapshot.findIndex((k) => k >= cursor) : 0;
      const from = start < 0 ? snapshot.length : start;
      const slice = snapshot.slice(from, from + size);
      const complete = from + size >= snapshot.length;
      return { complete, cursor: complete ? null : snapshot[from + size], keys: slice.map((key) => ({ key })) };
    },
  };
}
