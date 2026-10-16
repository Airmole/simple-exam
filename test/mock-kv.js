// 内存版 KV，模拟 EdgeOne KV 接口（list 支持 prefix/limit/cursor）
export function createMockKV() {
  const map = new Map();
  return {
    store: map,
    async get(key, opts) {
      const v = map.get(key);
      if (v === undefined) return null;
      if (opts && (opts === 'json' || opts.type === 'json')) {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    async list({ prefix = '', limit = 256, cursor } = {}) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      let start = 0;
      if (cursor) {
        const i = keys.indexOf(cursor);
        start = i >= 0 ? i : keys.length;
      }
      const slice = keys.slice(start, start + limit);
      const complete = start + limit >= keys.length;
      return { complete, cursor: complete ? null : keys[start + limit], keys: slice.map((key) => ({ key })) };
    },
  };
}
