// KV 数据模型
//
// exam:record:<recordId>  单次答题记录（含逐题明细）
// exam:user:<sub>         用户索引（记录其所有 recordId、最高分、最快用时）
// exam:stats              汇总统计（考试人数、次数、合格率等）
//
// 排名不额外落库：由 exam:record: 前缀扫描后在内存中聚合（用户取最高分，同分用时短优先）

const RECORD_PREFIX = 'exam:record:';
const USER_PREFIX = 'exam:user:';
const STATS_KEY = 'exam:stats';

async function listAllKeys(kv, prefix) {
  const keys = [];
  let cursor;
  do {
    const res = await kv.list({ prefix, limit: 256, cursor });
    (res.keys || []).forEach((k) => keys.push(k.key ?? k.name ?? k));
    cursor = res.complete ? null : res.cursor;
  } while (cursor);
  return keys;
}

export async function getJSON(kv, key, fallback = null) {
  const raw = await kv.get(key, { type: 'json' });
  return raw ?? fallback;
}

export async function putJSON(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

export const RECORD_ID_PREFIX = RECORD_PREFIX;

export async function saveRecord(kv, record) {
  record.id = record.id || `${record.sub}_${record.startedAt}_${Math.random().toString(36).slice(2, 8)}`;
  record.key = `${RECORD_PREFIX}${record.id}`;
  await putJSON(kv, record.key, record);
  await updateUserIndex(kv, record);
  await updateStats(kv, record);
  return record;
}

async function updateUserIndex(kv, record) {
  const key = `${USER_PREFIX}${record.sub}`;
  const idx = (await getJSON(kv, key)) || { sub: record.sub, name: record.name, records: [] };
  idx.name = record.name || idx.name;
  if (!idx.records.includes(record.id)) idx.records.push(record.id);

  const isPareto = !idx.best || (idx.best.score ?? -1) < record.score
    || ((idx.best.score ?? -1) === record.score && (record.durationMs ?? Infinity) < (idx.best.durationMs ?? Infinity));
  if (isPareto) {
    idx.best = { recordId: record.id, score: record.score, durationMs: record.durationMs, finishedAt: record.finishedAt };
  }
  idx.attempts = idx.records.length;
  await putJSON(kv, key, idx);
}

async function updateStats(kv, record) {
  const s = (await getJSON(kv, STATS_KEY)) || {
    uniqueUsers: 0,
    attempts: 0,
    passed: 0,
    scoreSum: 0,
    maxScore: null,
    minScore: null,
    fastestMs: null,
    slowestMs: null,
    updatedAt: 0,
  };
  s.attempts += 1;
  if (record.score >= record.passScore) s.passed += 1;
  s.scoreSum += record.score;
  s.maxScore = s.maxScore === null ? record.score : Math.max(s.maxScore, record.score);
  s.minScore = s.minScore === null ? record.score : Math.min(s.minScore, record.score);
  if (typeof record.durationMs === 'number') {
    s.fastestMs = s.fastestMs === null ? record.durationMs : Math.min(s.fastestMs, record.durationMs);
    s.slowestMs = s.slowestMs === null ? record.durationMs : Math.max(s.slowestMs, record.durationMs);
  }
  s.updatedAt = Date.now();
  // uniqueUsers 用用户索引数量校正，避免并发累加误差
  const userKeys = await listAllKeys(kv, USER_PREFIX);
  s.uniqueUsers = userKeys.length;
  await putJSON(kv, STATS_KEY, s);
}

export async function listRecords(kv) {
  const keys = await listAllKeys(kv, RECORD_PREFIX);
  const records = await Promise.all(keys.map((k) => getJSON(kv, k)));
  return records.filter(Boolean).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export async function getRecord(kv, id) {
  return getJSON(kv, `${RECORD_PREFIX}${id}`);
}

export async function getStats(kv) {
  const s = await getJSON(kv, STATS_KEY);
  if (!s) return null;
  const attempts = s.attempts || 0;
  return {
    ...s,
    passRate: attempts ? Math.round((s.passed / attempts) * 1000) / 10 : 0,
    avgScore: attempts ? Math.round((s.scoreSum / attempts) * 10) / 10 : 0,
  };
}

/**
 * 排名：同一用户取最高分，同分用时短者靠前。
 * 只有已提交（finishedAt 存在）的记录参与排名。
 */
export async function buildRanking(kv) {
  const records = await listRecords(kv);
  const best = new Map();
  for (const r of records) {
    if (!r.finishedAt) continue;
    const prev = best.get(r.sub);
    const dur = r.durationMs ?? Number.MAX_SAFE_INTEGER;
    if (!prev
      || r.score > prev.score
      || (r.score === prev.score && dur < (prev.durationMs ?? Number.MAX_SAFE_INTEGER))) {
      best.set(r.sub, { sub: r.sub, name: r.name, score: r.score, durationMs: dur, finishedAt: r.finishedAt, attemptId: r.id });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score
      || (a.durationMs ?? Number.MAX_SAFE_INTEGER) - (b.durationMs ?? Number.MAX_SAFE_INTEGER)
      || (a.finishedAt || 0) - (b.finishedAt || 0))
    .map((item, i) => ({ ...item, rank: i + 1 }));
}
