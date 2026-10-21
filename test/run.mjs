import { createMockKV } from './mock-kv.js';
import { handleApi } from '../edge-functions/api/_lib/router.js';
import { createSession } from '../edge-functions/api/_lib/oidc.js';

// 题库与题库总量：用例里按实际题量算分，换题库不用改断言
const { getBank } = await import('../edge-functions/api/_lib/questions.js');
const { answerOf, bankSize } = await (async () => {
  const bank = await getBank();
  const map = new Map(bank.map((q) => [q.id, q.answer]));
  return { answerOf: (id) => map.get(id) ?? null, bankSize: bank.length };
})();
const QUESTION_COUNT = Number(10);
const PASS_SCORE = Number(60);
const PER_QUESTION = Number(10);
const kv = createMockKV();

// EdgeOne 是把绑定名注入成「全局变量」的，env 里并没有它。
// 这里照着实情模拟，顺便暴露 config.js 曾经只在 env 上找绑定的 bug。
globalThis.EXAM_KV = kv;
// 反向验证：env 上残留一个同名占位也不该影响取到真正的绑定
const ENV = {
  EXAM_KV: 'kv-binding-name-not-the-object',
  SESSION_SECRET: 'test-secret',
  SITE_URL: 'http://127.0.0.1:8787',
  ADMIN_USERS: 'admin@corp.com,张三',
  SITE_NAME: '测试考试系统',
  SITE_LOGO: 'T',
  BRAND_COLOR: '#123456',
  EXAM_QUESTION_COUNT: '10',
  EXAM_POINTS_PER_QUESTION: '10',
  EXAM_PASS_SCORE: '60',
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
  const req = new Request(`http://127.0.0.1:8787${path}`, {
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

console.log('\n[0.1] 站点配置');
{
  const { getConfig, parseDeadline } = await import('../edge-functions/api/_lib/config.js');
  const site = await call('GET', '/api/site');
  check('GET /api/site 200', site.status === 200, site.text);
  check('站点名取 SITE_NAME', site.json.siteName === '测试考试系统', site.text);
  check('Logo 取 SITE_LOGO', site.json.logo === 'T');
  check('主题色取 BRAND_COLOR', site.json.brandColor === '#123456');
  check('未配置截止时不截止', site.json.closed === false && site.json.deadlineAt === null);

  const c = getConfig({});
  check('默认站点名', c.siteName === '通用单选题考试系统', c.siteName);
  check('非法主题色回退默认', getConfig({ BRAND_COLOR: 'red' }).brandColor === '#0f5fff');
  check('非法 SITE_URL 视为未配置', getConfig({ SITE_URL: 'exam.example.com' }).siteUrl === '');
  check('SITE_URL 去掉结尾斜杠', getConfig({ SITE_URL: 'https://exam.example.com/' }).siteUrl === 'https://exam.example.com');
  check('开关缺省为开', getConfig({}).showRanking && getConfig({}).showAnswer && getConfig({}).keepRecords);
  check('开关可关', getConfig({ EXAM_SHOW_RANKING: 'false', EXAM_SHOW_ANSWER: '0', EXAM_KEEP_RECORDS: 'off' }).showRanking === false
    && getConfig({ EXAM_SHOW_ANSWER: '0' }).showAnswer === false
    && getConfig({ EXAM_KEEP_RECORDS: 'off' }).keepRecords === false);
  check('次数缺省不限', getConfig({}).maxAttempts === 0);
  check('次数正整数生效', getConfig({ EXAM_MAX_ATTEMPTS: '3' }).maxAttempts === 3);

  // 截止时间按北京时间解析
  check('解析 2026-12-31 23:59', parseDeadline('2026-12-31 23:59') === Date.UTC(2026, 11, 31, 15, 59), String(parseDeadline('2026-12-31 23:59')));
  check('支持 T 分隔与秒', parseDeadline('2026-01-01T00:00:00') === Date.UTC(2025, 11, 31, 16, 0, 0));
  check('非法截止时间返回 null', parseDeadline('明天') === null && parseDeadline('') === null);
}

console.log('\n[1] 公开接口');
{
  const r = await call('GET', '/api/meta');
  check('GET /api/meta 200', r.status === 200, r.text);
  check('题库题量与文件一致', r.json.bankSize === bankSize, JSON.stringify(r.json));
  check('规则满分 = 题数 × 每题分值', r.json.rules.totalScore === QUESTION_COUNT * PER_QUESTION, JSON.stringify(r.json.rules));
  check('未登录不是管理员', r.json.isAdmin === false);
  check('meta 带站点配置', r.json.site && r.json.site.siteName === '测试考试系统', JSON.stringify(r.json.site));
  check('未登录不限次数提示为空', r.json.attemptsLeft === null);
}
{
  const r = await call('GET', '/api/exam/rules');
  check('规则：抽题数/每题分值/满分/及格/时长按环境变量',
    r.json.rules.questionCount === QUESTION_COUNT && r.json.rules.pointsPerQuestion === PER_QUESTION
    && r.json.rules.totalScore === QUESTION_COUNT * PER_QUESTION && r.json.rules.passScore === PASS_SCORE
    && r.json.rules.durationMinutes === 30, r.text);
  check('题量超过题库时按题库上限', r.json.rules.questionCount <= bankSize);
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
  check(`抽 ${QUESTION_COUNT} 题`, paper.questions.length === QUESTION_COUNT, String(paper.questions.length));
  check('题目不重复', new Set(paper.questions.map(q => q.id)).size === QUESTION_COUNT);
  check('题号都在题库里', paper.questions.every(q => answerOf(q.id) != null));
  check('下发题目不含正确答案', paper.questions.every(q => q.answer === undefined));
  check('原题号字段存在', paper.questions.every(q => q.originalId === q.id));
  check('返回开始时间/过期时间', !!paper.startedAt && paper.expiresAt > paper.startedAt);
  check('时长 1800 秒', paper.durationSeconds === 1800);
}

console.log('\n[4] 交卷判分（全对）');
let perfectRecordId;
{
  const answers = {};
  paper.questions.forEach(q => { answers[q.id] = answerOf(q.id); });
  const r = await call('POST', '/api/exam/submit', { cookie, body: { answers } });
  check('submit 200', r.status === 200, r.text);
  check(`满分 ${QUESTION_COUNT * PER_QUESTION}`, r.json.score === QUESTION_COUNT * PER_QUESTION, String(r.json.score));
  check('合格', r.json.passed === true);
  check('返回记录 id', !!r.json.recordId);
  check('记录逐题明细', r.json.details.length === QUESTION_COUNT);
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
  const answers = {};
  // 只答对前 3 题
  qs.forEach((q, i) => { if (i < 3) answers[q.id] = answerOf(q.id); else answers[q.id] = 'Z'; });
  const r = await call('POST', '/api/exam/submit', { cookie: c2, body: { answers } });
  check(`${3 * PER_QUESTION} 分`, r.json.score === 3 * PER_QUESTION, String(r.json.score));
  check('不合格', r.json.passed === false);
  // 非法选项（多选/不在选项里）按未作答处理，不会被记成用户答案
  check('非法选项按未作答', r.json.details.filter(d => d.submittedAnswer === null).length === QUESTION_COUNT - 3,
    JSON.stringify(r.json.details.map(d => d.submittedAnswer)));
}

console.log('\n[6] 排名（同分用时短靠前）');
{
  // 再考一次拿次高分（另一用户只答对 1 题）
  const c3 = await sessionCookie({ sub: 'u_student_3', name: '赵六', username: 'zhaoliu' });
  const start = await call('POST', '/api/exam/start', { cookie: c3, body: {} });
  const qs = start.json.questions;
  const answers = {};
  qs.forEach((q, i) => { answers[q.id] = i < 1 ? answerOf(q.id) : 'Z'; });
  await call('POST', '/api/exam/submit', { cookie: c3, body: { answers } });

  const r = await call('GET', '/api/ranking');
  check('ranking 200', r.status === 200, r.text);
  check('排名第一是满分', r.json.ranking[0].score === QUESTION_COUNT * PER_QUESTION, JSON.stringify(r.json.ranking));
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
  check('合格率 33.3（只有满分那次合格）', s.json.stats.passRate === 33.3, String(s.json.stats.passRate));
  check('最高分是满分', s.json.stats.maxScore === QUESTION_COUNT * PER_QUESTION);
  check(`最低分 ${PER_QUESTION}`, s.json.stats.minScore === PER_QUESTION);
  const expectedAvg = Math.round(((QUESTION_COUNT * PER_QUESTION) + PER_QUESTION + (3 * PER_QUESTION)) / 3 * 10) / 10;
  check('平均分按实际得分算', s.json.stats.avgScore === expectedAvg, `${s.json.stats.avgScore} vs ${expectedAvg}`);
  check('最快/最慢答题有值', s.json.extra.fastest && s.json.extra.slowest);

  const rec = await call('GET', '/api/admin/records', { cookie: c });
  check('管理员 records 200', rec.status === 200);
  check('记录 3 条', rec.json.records.length === 3, String(rec.json.records.length));
  check('记录含姓名/开始/结束/用时', rec.json.records.every(r => r.name && r.startedAt && r.finishedAt && r.durationMs >= 0));

  const d = await call('GET', `/api/admin/record?id=${perfectRecordId}`, { cookie: c });
  check('记录详情 200', d.status === 200, d.text);
  check(`详情含 ${QUESTION_COUNT} 题明细`, d.json.record.details.length === QUESTION_COUNT);
  check('详情含正确答案', d.json.record.details.every(x => x.correctAnswer && x.submittedAnswer));
}

console.log('\n[8] 同名用户多次考试取最高分');
{
  const start = await call('POST', '/api/exam/start', { cookie, body: {} });
  const qs = start.json.questions;
  const answers = {};
  qs.forEach((q, i) => { answers[q.id] = i < 2 ? answerOf(q.id) : 'Z'; }); // 次高分，低于满分
  await call('POST', '/api/exam/submit', { cookie, body: { answers } });
  const r = await call('GET', '/api/ranking');
  const me = r.json.ranking.find(x => x.name === '李四');
  check('李四仍取最高分', me && me.score === QUESTION_COUNT * PER_QUESTION, JSON.stringify(me));
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
  // 线上现状：OneID 应用里没登记登出回跳地址，fclogout 回 invalid_request。
  // 这时候不能再把人扔过去看 JSON 报错页，得自己回站内。
  const rejectFetch = async (url) => (String(url).includes('/fclogout')
    ? new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 })
    : realFetch(url));
  const realFetch = globalThis.fetch;
  globalThis.fetch = rejectFetch;
  try {
    const c = await sessionCookie(student);
    const r = await call('GET', '/api/auth/logout', { cookie: c });
    const location = r.headers.get('location') || '';
    check('回跳被拒时退回本站首页', location === 'http://127.0.0.1:8787/', location);
    check('回跳被拒时也清了会话 cookie', /exam_session=;/.test(String(r.headers.getSetCookie ? r.headers.getSetCookie().join(';') : r.headers.get('set-cookie'))));
  } finally {
    globalThis.fetch = realFetch;
  }

  // OneID 受理（302 到回跳地址）时才把人交给 fclogout
  const acceptFetch = async (url) => (String(url).includes('/fclogout')
    ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8787/' } })
    : realFetch(url));
  globalThis.fetch = acceptFetch;
  try {
    const c = await sessionCookie(student);
    const r = await call('GET', '/api/auth/logout', { cookie: c });
    check('受理时仍跳 OneID', String(r.headers.get('location')).includes('/fclogout'), String(r.headers.get('location')));
  } finally {
    globalThis.fetch = realFetch;
  }

  // 后面这几项只看跳转地址怎么拼，固定成「OneID 受理」免得受网络影响
  globalThis.fetch = acceptFetch;
  try {
    await checkLogoutTargets();
  } finally {
    globalThis.fetch = realFetch;
  }

  // 回跳地址配成外站、且 OneID 不认时，本站只该回自己家，别把人送去别人的域名
  globalThis.fetch = rejectFetch;
  try {
    const req = new Request('http://127.0.0.1:8787/api/auth/logout');
    const saved = ENV.OIDC_LOGOUT_REDIRECT_URI;
    ENV.OIDC_LOGOUT_REDIRECT_URI = 'https://evil.example.com/';
    let loc;
    try {
      loc = (await handleApi({ request: req, env: ENV, params: {} })).headers.get('location');
    } finally {
      if (saved === undefined) delete ENV.OIDC_LOGOUT_REDIRECT_URI;
      else ENV.OIDC_LOGOUT_REDIRECT_URI = saved;
    }
    check('外站回跳地址只回本站首页', loc === 'http://127.0.0.1:8787/', String(loc));
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function checkLogoutTargets() {
  const c = await sessionCookie(student);
  const r = await call('GET', '/api/auth/logout', { cookie: c });
  check('logout 302', r.status === 302, String(r.status));
  // 回归：曾经跳到 issuer + /fclogout 且不带 client_id（Missing client_id），
  // 再被改成不存在的 /authz/fclogout（404 page not found）
  const location = r.headers.get('location') || '';
  const out = new URL(location);
  check('logout 跳到 OneID 的 fclogout', out.origin + out.pathname === `${ENV.OIDC_ISSUER}/fclogout`, location);
  check('logout 带 client_id', out.searchParams.get('client_id') === ENV.OIDC_CLIENT_ID, location);
  check('logout 带回跳地址', out.searchParams.get('post_logout_redirect_uri') === 'http://127.0.0.1:8787/', location);

  // 回跳地址可配：填 OneID 里真正登记过的那个，别硬拼站点根
  const savedEnv = { ...ENV };
  ENV.OIDC_LOGOUT_REDIRECT_URI = 'http://127.0.0.1:8787/logout-done';
  try {
    const r2 = await call('GET', '/api/auth/logout', { cookie: c });
    const loc2 = r2.headers.get('location') || '';
    check('回跳地址取 OIDC_LOGOUT_REDIRECT_URI', new URL(loc2).searchParams.get('post_logout_redirect_uri') === ENV.OIDC_LOGOUT_REDIRECT_URI, loc2);
  } finally {
    delete ENV.OIDC_LOGOUT_REDIRECT_URI;
    Object.assign(ENV, savedEnv);
  }
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

console.log('\n[13] 次数限制 / 截止时间 / 排名开关（独立 KV）');
{
  const limitKv = createMockKV();
  const savedGlobal = globalThis.EXAM_KV;
  const savedEnv = { ...ENV };
  globalThis.EXAM_KV = limitKv;
  const studentC = await sessionCookie({ sub: 'u_limit', name: '限次考生', username: 'limit' });

  try {
    ENV.EXAM_MAX_ATTEMPTS = '1';
    const first = await call('POST', '/api/exam/start', { cookie: studentC, body: {} });
    check('第 1 次可开考', first.status === 200, first.text);
    const answers = {};
    first.json.questions.forEach((q) => { answers[q.id] = answerOf(q.id); });
    await call('POST', '/api/exam/submit', { cookie: studentC, body: { answers } });
    const second = await call('POST', '/api/exam/start', { cookie: studentC, body: {} });
    check('超过次数被拒（403）', second.status === 403 && second.json.code === 'ATTEMPTS_EXCEEDED', second.text);
    const me = await call('GET', '/api/auth/me', { cookie: studentC });
    check('me 返回剩余次数 0', me.json.attemptsLeft === 0 && me.json.attempts === 1, me.text);

    // 截止时间：设成过去即立刻关闭
    ENV.EXAM_MAX_ATTEMPTS = '0';
    ENV.EXAM_DEADLINE = '2020-01-01 00:00';
    const closedStart = await call('POST', '/api/exam/start', { cookie: studentC, body: {} });
    check('截止后不可开考（403 EXAM_CLOSED）', closedStart.status === 403 && closedStart.json.code === 'EXAM_CLOSED', closedStart.text);
    const siteClosed = await call('GET', '/api/site');
    check('截止后 /api/site 标记 closed', siteClosed.json.closed === true && siteClosed.json.deadline === '2020-01-01 00:00', siteClosed.text);
    delete ENV.EXAM_DEADLINE;

    // 排名开关
    ENV.EXAM_SHOW_RANKING = 'false';
    const noRanking = await call('GET', '/api/ranking');
    check('关闭排名后接口 403', noRanking.status === 403 && noRanking.json.code === 'RANKING_DISABLED', noRanking.text);
    const siteNoRank = await call('GET', '/api/site');
    check('关闭排名后 /api/site 同步', siteNoRank.json.showRanking === false, siteNoRank.text);
    delete ENV.EXAM_SHOW_RANKING;
  } finally {
    Object.keys(ENV).forEach((k) => { if (!(k in savedEnv)) delete ENV[k]; });
    Object.assign(ENV, savedEnv);
    globalThis.EXAM_KV = savedGlobal;
  }
}

console.log('\n[14] 解析开关与不留存记录（独立 KV）');
{
  const privacyKv = createMockKV();
  const savedGlobal = globalThis.EXAM_KV;
  const savedEnv = { ...ENV };
  globalThis.EXAM_KV = privacyKv;
  const c = await sessionCookie({ sub: 'u_privacy', name: '隐私考生', username: 'privacy' });

  try {
    // 关闭解析：只给分，不给答案与对错
    ENV.EXAM_SHOW_ANSWER = 'false';
    const start1 = await call('POST', '/api/exam/start', { cookie: c, body: {} });
    const answers1 = {};
    start1.json.questions.forEach((q) => { answers1[q.id] = answerOf(q.id); });
    const r1 = await call('POST', '/api/exam/submit', { cookie: c, body: { answers: answers1 } });
    check('关闭解析仍正常判分', r1.status === 200 && r1.json.score === QUESTION_COUNT * PER_QUESTION, r1.text);
    check('关闭解析不回正确答案', r1.json.details.every((d) => d.correctAnswer === null && d.isCorrect === null), r1.text.slice(0, 200));
    check('关闭解析仍回用户作答', r1.json.details.every((d) => d.submittedAnswer), r1.text.slice(0, 200));

    // 管理端详情同样被裁剪
    const adminC = await sessionCookie(adminUser);
    const detail = await call('GET', `/api/admin/record?id=${r1.json.recordId}`, { cookie: adminC });
    check('管理端详情同步裁剪正确答案', detail.json.record.details.every((d) => d.correctAnswer === null), detail.text.slice(0, 200));
    delete ENV.EXAM_SHOW_ANSWER;

    // 不留存记录：不落 KV，但成绩照样返回
    ENV.EXAM_KEEP_RECORDS = 'false';
    const before = privacyKv.store.size;
    const start2 = await call('POST', '/api/exam/start', { cookie: c, body: {} });
    const r2 = await call('POST', '/api/exam/submit', { cookie: c, body: { answers: {} } });
    check('不留存时仍返回成绩', r2.status === 200 && r2.json.score === 0, r2.text);
    check('不留存时 recordId 为空', r2.json.recordId === null, JSON.stringify(r2.json.recordId));
    check('不留存时不写记录', privacyKv.store.size === before, `${before} -> ${privacyKv.store.size}`);
    // 前面那一轮开了解析开关、留着记录，排名里那条是它；这一轮不该再新增
    const ranking2 = await call('GET', '/api/ranking');
    check('不留存时不再产生新记录', ranking2.json.ranking.filter((x) => x.sub === 'u_privacy').length === 1, ranking2.text.slice(0, 200));
    check('排名里只有上一轮的分数', ranking2.json.ranking.find((x) => x.sub === 'u_privacy').score === QUESTION_COUNT * PER_QUESTION, ranking2.text.slice(0, 200));
    delete ENV.EXAM_KEEP_RECORDS;
  } finally {
    Object.keys(ENV).forEach((k) => { if (!(k in savedEnv)) delete ENV[k]; });
    Object.assign(ENV, savedEnv);
    globalThis.EXAM_KV = savedGlobal;
  }
}

console.log('\n[15] 超时交卷被拒');
{
  const lateKv = createMockKV();
  const savedGlobal = globalThis.EXAM_KV;
  globalThis.EXAM_KV = lateKv;
  try {
    const c = await sessionCookie({ sub: 'u_late', name: '迟到考生', username: 'late' });
    const start = await call('POST', '/api/exam/start', { cookie: c, body: {} });
    // 把已落库的试卷改成「1 小时前就过期」
    const key = 'exam_paper_u_late';
    const paperRaw = JSON.parse(await lateKv.get(key));
    paperRaw.expiresAt = Date.now() - 3600 * 1000;
    await lateKv.put(key, JSON.stringify(paperRaw));
    const r = await call('POST', '/api/exam/submit', { cookie: c, body: { answers: {} } });
    check('超时交卷 409 EXAM_TIMEOUT', r.status === 409 && r.json.code === 'EXAM_TIMEOUT', r.text);
    check('超时后试卷被清理', (await lateKv.get(key)) === null);
  } finally {
    globalThis.EXAM_KV = savedGlobal;
  }
}

console.log(`\n结果: ${pass} 通过, ${failCount} 失败`);
process.exit(failCount ? 1 : 0);
