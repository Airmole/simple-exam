import { createMockKV } from './mock-kv.js';
import { handleApi } from '../edge-functions/api/_lib/router.js';
import { createSession } from '../edge-functions/api/_lib/oidc.js';

const kv = createMockKV();

// EdgeOne 是把绑定名注入成「全局变量」的，env 里并没有它。
// 这里照着实情模拟，顺便暴露 config.js 曾经只在 env 上找绑定的 bug。
globalThis.EXAM_KV = kv;
// 反向验证：env 上残留一个同名占位也不该影响取到真正的绑定
const ENV = {
  EXAM_KV: 'kv-binding-name-not-the-object',
  SESSION_SECRET: 'test-secret',
  SITE_URL: 'https://dji-exam.airmole.cn',
  ADMIN_USERS: 'admin@corp.com,张三',
  EXAM_QUESTION_COUNT: '50',
  EXAM_POINTS_PER_QUESTION: '2',
  EXAM_PASS_SCORE: '80',
  EXAM_DURATION_MINUTES: '30',
  OIDC_ISSUER: 'https://oauth2.account.tencent.com/authz/oidc/v2/1492474500942414067',
  OIDC_CLIENT_ID: '1492474500942414067',
};

let pass = 0, failCount = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name} ${extra}`); }
};

async function call(method, path, { body, cookie, headers = {} } = {}) {
  const h = { ...headers };
  if (body) h['content-type'] = 'application/json';
  if (cookie) h['cookie'] = cookie;
  const req = new Request(`https://dji-exam.airmole.cn${path}`, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handleApi({ request: req, env: ENV, params: {} });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { status: res.status, json, headers: res.headers, text };
}

async function sessionCookie(user) {
  const token = await createSession('test-secret', user);
  return `exam_session=${encodeURIComponent(token)}`;
}

const student = { sub: 'u_student_1', name: '李四', username: 'lisi', email: 'lisi@corp.com' };
const other = { sub: 'u_student_2', name: '王五', username: 'wangwu', email: 'wangwu@corp.com' };
const adminUser = { sub: 'u_admin', name: '管理员', username: 'admin', email: 'admin@corp.com' };

console.log('\n[0] KV 绑定解析');
{
  const { getConfig, getKV } = await import('../edge-functions/api/_lib/config.js');
  const config = getConfig(ENV);
  check('默认绑定名 EXAM_KV', config.kvBinding === 'EXAM_KV');
  check('优先取运行时全局绑定', getKV(ENV, config) === kv);
  check('env 上的非对象占位不会误用', getKV(ENV, config) !== 'kv-binding-name-not-the-object');

  // 全局没有时回退 env[绑定名]（兼容把绑定挂在 env 的运行时）
  const saved = globalThis.EXAM_KV;
  delete globalThis.EXAM_KV;
  check('全局缺失时回退 env.EXAM_KV', getKV({ EXAM_KV: kv }, config) === kv);
  check('自定义 KV_BINDING 生效', getKV({ EXAM_STORE: kv }, getConfig({ KV_BINDING: 'EXAM_STORE' })) === kv);
  let err = null;
  try { getKV({}, config); } catch (e) { err = e; }
  check('完全缺失时报错并提示绑定名', !!err && err.message.includes('EXAM_KV'), String(err && err.message));
  globalThis.EXAM_KV = saved;
}

console.log('\n[1] 公开接口');
{
  const r = await call('GET', '/api/meta');
  check('GET /api/meta 200', r.status === 200, r.text);
  check('题库 100 题', r.json.bankSize === 100, JSON.stringify(r.json));
  check('规则满分 100', r.json.rules.totalScore === 100);
  check('未登录不是管理员', r.json.isAdmin === false);
}
{
  const r = await call('GET', '/api/exam/rules');
  check('规则：50题/2分/100总分/80及格/30分钟',
    r.json.rules.questionCount === 50 && r.json.rules.pointsPerQuestion === 2
    && r.json.rules.totalScore === 100 && r.json.rules.passScore === 80
    && r.json.rules.durationMinutes === 30, r.text);
}

console.log('\n[2] 未登录保护');
{
  for (const p of ['/api/exam/start', '/api/exam/questions', '/api/exam/submit']) {
    const r = await call('POST', p, { body: {} });
    if (p === '/api/exam/questions') {
      const g = await call('GET', p);
      check(`${p} 未登录 401`, g.status === 401, g.text);
    } else {
      check(`${p} 未登录 401`, r.status === 401, r.text);
    }
  }
}

console.log('\n[3] 开始考试');
let paper, cookie;
{
  cookie = await sessionCookie(student);
  const r = await call('POST', '/api/exam/start', { cookie, body: {} });
  check('start 200', r.status === 200, r.text);
  paper = r.json;
  check('抽 50 题', paper.questions.length === 50, String(paper.questions.length));
  check('题目不重复', new Set(paper.questions.map(q => q.id)).size === 50);
  check('题号在 1-100', paper.questions.every(q => Number.isInteger(q.id) && q.id >= 1 && q.id <= 100));
  check('下发题目不含正确答案', paper.questions.every(q => q.answer === undefined));
  check('原题号字段存在', paper.questions.every(q => q.originalId === q.id));
  check('返回开始时间/过期时间', !!paper.startedAt && paper.expiresAt > paper.startedAt);
  check('时长 1800 秒', paper.durationSeconds === 1800);
}

console.log('\n[4] 交卷判分（全对）');
let perfectRecordId;
{
  const { answerOf } = await import('../edge-functions/api/_lib/questions.js');
  const answers = {};
  paper.questions.forEach(q => { answers[q.id] = answerOf(q.id); });
  const r = await call('POST', '/api/exam/submit', { cookie, body: { answers } });
  check('submit 200', r.status === 200, r.text);
  check('满分 100', r.json.score === 100, String(r.json.score));
  check('合格', r.json.passed === true);
  check('记录逐题明细', r.json.details.length === 50);
  check('明细含正确答案与用户答案', r.json.details.every(d => d.correctAnswer && d.submittedAnswer));
  check('用时 >= 0', r.json.durationMs >= 0);
  perfectRecordId = r.json.recordId;
}
{
  const r = await call('POST', '/api/exam/submit', { cookie, body: {} });
  check('重复交卷 409', r.status === 409, r.text);
}

console.log('\n[5] 部分正确与不合格');
{
  const c2 = await sessionCookie(other);
  const start = await call('POST', '/api/exam/start', { cookie: c2, body: {} });
  const qs = start.json.questions;
  const { answerOf } = await import('../edge-functions/api/_lib/questions.js');
  const answers = {};
  // 只答对前 10 题 = 20 分
  qs.forEach((q, i) => { if (i < 10) answers[q.id] = answerOf(q.id); else answers[q.id] = 'Z'; });
  const r = await call('POST', '/api/exam/submit', { cookie: c2, body: { answers } });
  check('20 分', r.json.score === 20, String(r.json.score));
  check('不合格', r.json.passed === false);
  check('错题记录用户答案 Z', r.json.details.filter(d => d.submittedAnswer === 'Z').length === 40);
}

console.log('\n[6] 排名（同分用时短靠前）');
{
  // 再考一次拿更高分（另一用户答 45 题 = 90 分）
  const c3 = await sessionCookie({ sub: 'u_student_3', name: '赵六', username: 'zhaoliu' });
  const start = await call('POST', '/api/exam/start', { cookie: c3, body: {} });
  const qs = start.json.questions;
  const { answerOf } = await import('../edge-functions/api/_lib/questions.js');
  const answers = {};
  qs.forEach((q, i) => { answers[q.id] = i < 45 ? answerOf(q.id) : 'Z'; });
  await call('POST', '/api/exam/submit', { cookie: c3, body: { answers } });

  const r = await call('GET', '/api/ranking');
  check('ranking 200', r.status === 200, r.text);
  check('排名第一是 100 分', r.json.ranking[0].score === 100, JSON.stringify(r.json.ranking));
  check('排名含 3 人', r.json.ranking.length === 3, String(r.json.ranking.length));
  const scores = r.json.ranking.map(x => x.score);
  check('按分数降序', scores.every((s, i) => i === 0 || scores[i - 1] >= s), JSON.stringify(scores));
  check('rank 连续从 1 开始', r.json.ranking.every((x, i) => x.rank === i + 1));
}

console.log('\n[7] 管理后台权限');
{
  const c = await sessionCookie(student);
  const s = await call('GET', '/api/admin/stats', { cookie: c });
  check('普通用户 stats 403', s.status === 403, s.text);
  const rec = await call('GET', '/api/admin/records', { cookie: c });
  check('普通用户 records 403', rec.status === 403, rec.text);
  const anon = await call('GET', '/api/admin/stats');
  check('未登录 stats 401', anon.status === 401, anon.text);
}
{
  const c = await sessionCookie(adminUser);
  const s = await call('GET', '/api/admin/stats', { cookie: c });
  check('管理员 stats 200', s.status === 200, s.text);
  check('考试人数 3', s.json.stats.uniqueUsers === 3, JSON.stringify(s.json.stats));
  check('考试次数 3', s.json.stats.attempts === 3, JSON.stringify(s.json.stats));
  check('合格率 66.7 (100/90 合格)', s.json.stats.passRate === 66.7, String(s.json.stats.passRate));
  check('最高分 100', s.json.stats.maxScore === 100);
  check('最低分 20', s.json.stats.minScore === 20);
  check('平均分 (100+90+20)/3=70', s.json.stats.avgScore === 70, String(s.json.stats.avgScore));
  check('最快/最慢答题有值', s.json.extra.fastest && s.json.extra.slowest);

  const rec = await call('GET', '/api/admin/records', { cookie: c });
  check('管理员 records 200', rec.status === 200);
  check('记录 3 条', rec.json.records.length === 3, String(rec.json.records.length));
  check('记录含姓名/开始/结束/用时', rec.json.records.every(r => r.name && r.startedAt && r.finishedAt && r.durationMs >= 0));

  const d = await call('GET', `/api/admin/record?id=${perfectRecordId}`, { cookie: c });
  check('记录详情 200', d.status === 200, d.text);
  check('详情含 50 题明细', d.json.record.details.length === 50);
  check('详情含正确答案', d.json.record.details.every(x => x.correctAnswer && x.submittedAnswer));
}

console.log('\n[8] 同名用户多次考试取最高分');
{
  const c = await sessionCookie(student);
  const start = await call('POST', '/api/exam/start', { cookie, body: {} });
  const qs = start.json.questions;
  const { answerOf } = await import('../edge-functions/api/_lib/questions.js');
  const answers = {};
  qs.forEach((q, i) => { answers[q.id] = i < 30 ? answerOf(q.id) : 'Z'; }); // 60 分，低于 100
  await call('POST', '/api/exam/submit', { cookie, body: { answers } });
  const r = await call('GET', '/api/ranking');
  const me = r.json.ranking.find(x => x.name === '李四');
  check('李四仍取最高分 100', me && me.score === 100, JSON.stringify(me));
  check('排名人数仍为 3', r.json.ranking.length === 3, String(r.json.ranking.length));
  const stats = await call('GET', '/api/admin/stats', { cookie: await sessionCookie(adminUser) });
  check('考试次数变 4', stats.json.stats.attempts === 4, String(stats.json.stats.attempts));
  check('考试人数仍 3', stats.json.stats.uniqueUsers === 3, String(stats.json.stats.uniqueUsers));
}

console.log('\n[9] 用时不可伪造（客户端 startedAt 不能把用时报短）');
{
  const c = await sessionCookie({ sub: 'u_forge', name: '伪造者', username: 'forge' });
  const start = await call('POST', '/api/exam/start', { cookie: c, body: {} });
  await new Promise((r) => setTimeout(r, 120));
  const ids = start.json.questions.map((q) => q.id);
  const r = await call('POST', '/api/exam/submit', {
    cookie: c,
    // 谎报开始时间为「未来」，试图让用时变成 0
    body: { answers: {}, startedAt: Date.now() + 10 * 60 * 1000, questionIds: ids },
  });
  check('提交成功', r.status === 200, r.text);
  check('用时以服务端记录为准（>0）', r.json.durationMs >= 100, String(r.json.durationMs));
  check('用时不会被压成负数', r.json.durationMs >= 0, String(r.json.durationMs));
}

console.log('\n[10] KV key 规范（EdgeOne 只允许数字/字母/下划线）');
{
  const keyOk = /^[0-9A-Za-z_]+$/;
  const bad = [...kv.store.keys()].filter((k) => !keyOk.test(k));
  check('所有落库 key 合法', bad.length === 0, bad.slice(0, 3).join(','));
  check('统计 key 为 exam_stats', kv.store.has('exam_stats'));
  // sub 里带特殊字符也不能把 key 弄脏
  const c = await sessionCookie({ sub: 'oidc|user:01.x-y', name: '特殊字符', username: 'sp' });
  const start = await call('POST', '/api/exam/start', { cookie: c, body: {} });
  check('特殊字符 sub 可开考', start.status === 200, start.text);
  const dirty = [...kv.store.keys()].filter((k) => !keyOk.test(k));
  check('特殊字符 sub 落库 key 仍合法', dirty.length === 0, dirty.slice(0, 3).join(','));
  await call('POST', '/api/exam/submit', { cookie: c, body: { answers: {} } });
}

console.log('\n[11] 登出与未知接口');
{
  const c = await sessionCookie(student);
  const r = await call('GET', '/api/auth/logout', { cookie: c });
  check('logout 302', r.status === 302, String(r.status));
  // 回归：曾经跳到 issuer + /fclogout 且不带 client_id（Missing client_id），
  // 再被改成不存在的 /authz/fclogout（404 page not found）
  const location = r.headers.get('location') || '';
  const out = new URL(location);
  check('logout 跳到 OneID 的 fclogout', out.origin + out.pathname === `${ENV.OIDC_ISSUER}/fclogout`, location);
  check('logout 带 client_id', out.searchParams.get('client_id') === ENV.OIDC_CLIENT_ID, location);
  check('logout 带回跳地址', out.searchParams.get('post_logout_redirect_uri') === 'https://dji-exam.airmole.cn/', location);
  check('logout 清除会话 cookie', /exam_session=;/.test(String(r.headers.getSetCookie ? r.headers.getSetCookie().join(';') : r.headers.get('set-cookie'))));
  const me = await call('GET', '/api/auth/me', { cookie: c });
  check('me 仍可解析旧 cookie（无状态会话）', me.status === 200);
  const nf = await call('GET', '/api/nope');
  check('未知接口 404', nf.status === 404, nf.text);
}

console.log('\n[12] 空数据池上的首查分页（线上 cursor 严格校验）');
{
  // 独立一份干净 KV：没有任何 exam_record_ / exam_user_，模拟「还没人答题」
  const emptyKv = createMockKV();
  const saved = globalThis.EXAM_KV;
  globalThis.EXAM_KV = emptyKv;

  const r = await call('GET', '/api/ranking');
  check('空数据 ranking 200', r.status === 200, r.text);
  check('空数据 ranking 为空数组', Array.isArray(r.json && r.json.ranking) && r.json.ranking.length === 0, r.text);
  check('空数据报错不含 cursor', !String(r.text).includes('cursor'), r.text);

  // 首查不能把 cursor 传下去（边查边记录实际传参）
  const { buildRanking } = await import('../edge-functions/api/_lib/store.js');
  const got = [];
  const spyKv = {
    get: (...a) => emptyKv.get(...a),
    put: (...a) => emptyKv.put(...a),
    delete: (...a) => emptyKv.delete(...a),
    list: async (opts) => { got.push(opts.cursor); return emptyKv.list(opts); },
  };
  await buildRanking(spyKv);
  check('首查不带 cursor（传 undefined 会触发线上类型错误）', got.length === 1 && got[0] === undefined, JSON.stringify(got));

  // 有分页时靠 cursor 续翻，能翻完
  for (let i = 0; i < 300; i++) {
    await emptyKv.put(`exam_record_bulk${String(i).padStart(3, '0')}`,
      JSON.stringify({ id: `bulk${i}`, sub: `b${i}`, name: `批量${i}`, score: 60, durationMs: 1000, startedAt: 1, finishedAt: 2 }));
  }
  const many = await call('GET', '/api/ranking');
  check('300 条记录全部翻到（分页正确）', many.status === 200 && many.json.ranking.length === 300, many.text.slice(0, 120));

  globalThis.EXAM_KV = saved;
}

console.log(`\n结果: ${pass} 通过, ${failCount} 失败`);
process.exit(failCount ? 1 : 0);
