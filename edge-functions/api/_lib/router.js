// /api/* 路由分发
import { getConfig, getKV } from './config.js';
import { fail, noContent, ok, readJSON, withCookies } from './http.js';
import { ADMIN_SESSION_SECONDS, cookies, createAdminSession, createFlow, createSession, exchangeCode, fetchUserInfo, isAdmin, normalizeUser, readAdminSession, readFlow, readSession, decodeIdTokenClaims, buildLogoutUrl, logoutAccepted, verifyAdminPassword } from './oidc.js';
import { randomString } from './crypto.js';
import { drawQuestions, getBankSize } from './questions.js';
import { gradeSubmission } from './scoring.js';
import { buildRanking, countAttempts, getRecord, getStats, guestPaperKey, listRecords, maskDetails, paperKey, saveRecord } from './store.js';

function segments(request) {
  const { pathname } = new URL(request.url);
  // 统一以 /api 为前缀；兼容直接访问 [[default]] 的情况
  const clean = pathname.replace(/^\/api/, '').replace(/\/+$/, '');
  return clean.split('/').filter(Boolean);
}

// Response.redirect 只接受绝对地址，这里统一把站内相对路径补全
function redirectTo(request, target, config) {
  if (/^https?:\/\//i.test(target)) return target;
  const base = config.siteUrl || new URL(request.url).origin;
  return `${base.replace(/\/+$/, '')}${target.startsWith('/') ? '' : '/'}${target}`;
}

export async function handleApi(context) {
  const { request } = context;
  const config = getConfig(context.env);
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return noContent(204, { allow: 'GET,POST,PUT,DELETE,OPTIONS' });

  const parts = segments(request);
  const path = parts.join('/');

  // 站点配置不依赖 KV，KV 没绑也能先看到配置是否正确
  if (path === 'site' && method === 'GET') return ok(siteInfo(config));

  let kv;
  try {
    kv = getKV(context.env, config);
  } catch (e) {
    // 绑定缺失属于部署配置问题，单独给出 503 + 配置提示，别混进「服务异常」
    return fail(e.message, 503, { code: 'KV_BINDING_MISSING', binding: config.kvBinding });
  }

  try {
    // ---- 认证 ----
    if (path === 'auth/login') return await handleLogin(request, config);
    if (path === 'auth/callback') return await handleCallback(request, config);
    if (path === 'auth/logout') return await handleLogout(request, config);
    if (path === 'auth/me') return await handleMe(request, config, kv);
    // 后台密码登录：不依赖 OneID，配置了 ADMIN_PASSWORD 就能用
    if (path === 'auth/admin-login' && method === 'POST') return await handleAdminLogin(request, config);
    if (path === 'auth/admin-login' && method === 'GET') return fail('请用 POST 提交管理密码', 405);
    if (path === 'auth/admin-logout') return await handleAdminLogout(request, config);

    // ---- 考试规则 ----
    if (path === 'exam/rules') return ok({ rules: await publicRules(config) });

    const session = await readSession(request, config.sessionSecret);
    const admin = await adminState(request, config, session);

    // ---- 考试 ----
    // 游客（不登录）答题：只在 EXAM_ALLOW_GUEST 打开时放行，试卷按服务端签发的 gid 存取
    if (path === 'exam/start' && method === 'POST') return await handleExamStart(request, config, kv, session);
    if (path === 'exam/questions' && method === 'GET') {
      return await handleExamQuestions(config, kv, session, new URL(request.url).searchParams);
    }
    if (path === 'exam/submit' && method === 'POST') return await handleExamSubmit(request, config, kv, session);

    // ---- 排名 ----
    if (path === 'ranking' && method === 'GET') {
      if (!config.showRanking) return fail('本场考试未开放成绩排名', 403, { code: 'RANKING_DISABLED' });
      return ok({ ranking: await buildRanking(kv) });
    }

    // ---- 管理后台 ----
    if (path === 'admin/stats' && method === 'GET') return await handleAdminStats(kv, admin);
    if (path === 'admin/records' && method === 'GET') return await handleAdminRecords(kv, admin);
    if (path === 'admin/record' && method === 'GET') return await handleAdminRecord(config, kv, admin, new URL(request.url).searchParams);

    // ---- 站点元信息 ----
    if (path === 'meta' && method === 'GET') return ok(await metaInfo(config, session, admin, kv));

    return fail('接口不存在', 404);
  } catch (e) {
    return fail(`服务异常: ${e.message}`, 500);
  }
}

async function publicRules(config) {
  const bankSize = await getBankSize();
  return {
    // 题库不足时按实际题量出卷，总分随之变化，避免出现「抽 50 题」但题库只有 20 题
    questionCount: Math.min(config.questionCount, bankSize),
    pointsPerQuestion: config.pointsPerQuestion,
    totalScore: Math.min(config.questionCount, bankSize) * config.pointsPerQuestion,
    passScore: config.passScore,
    durationMinutes: config.durationMinutes,
    durationSeconds: config.durationMinutes * 60,
    maxAttemptsDesc: config.maxAttempts > 0 ? `每人最多 ${config.maxAttempts} 次` : '不限次数',
    showRanking: config.showRanking,
    showAnswer: config.showAnswer,
    // 游客能不能直接开考（不登录、不落库、不进排名）
    allowGuest: config.allowGuest,
  };
}

/** 站点品牌配置，前端据此渲染标题、Logo 与主题色 */
function siteInfo(config) {
  return {
    siteName: config.siteName,
    logo: config.siteLogo,
    brandColor: config.brandColor,
    showRanking: config.showRanking,
    // 不登录也能答题；考生不需要登录入口，顶部也就不再显示「登录」
    allowGuest: config.allowGuest,
    // 后台是否可用密码登录（前端据此渲染密码表单）
    adminPasswordLogin: config.adminPasswordEnabled,
    deadline: config.deadline,
    deadlineAt: config.deadlineAt,
    closed: config.deadlineAt != null && Date.now() >= config.deadlineAt,
  };
}

async function metaInfo(config, session, admin, kv) {
  const attempts = session && config.maxAttempts > 0 ? await countAttempts(kv, session.sub) : 0;
  return {
    siteUrl: config.siteUrl,
    site: siteInfo(config),
    bankSize: await getBankSize(),
    rules: await publicRules(config),
    user: session ? { name: session.name, username: session.username, sub: session.sub } : null,
    // 允许游客答题时，未登录也不再是「需要登录」的状态
    guest: !session && config.allowGuest,
    // 只认服务端算出来的管理员身份，前端仅用来决定入口显示
    isAdmin: admin.isAdmin,
    // 密码登录的后台会话没有 OneID 身份，单独给个名字
    adminVia: admin.via,
    // 已考次数与剩余次数，用于前端在开考前就拦住超次数的用户
    attempts,
    attemptsLeft: config.maxAttempts > 0 ? Math.max(0, config.maxAttempts - attempts) : null,
  };
}

/* ---------------- 认证 ---------------- */

async function handleLogin(request, config) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get('returnTo') || '/';
  const flow = await createFlow(request, config, returnTo);
  return withCookies(Response.redirect(flow.authorizeUrl, 302), cookies.setFlow(request, flow.token));
}

async function handleCallback(request, config) {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) {
    const msg = encodeURIComponent(url.searchParams.get('error_description') || error);
    return withCookies(Response.redirect(redirectTo(request, `/?auth_error=${msg}`, config), 302), cookies.clearFlow(request));
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const flow = await readFlow(request, config);
  if (!code || !flow || !state || state !== flow.state) {
    return withCookies(
      Response.redirect(redirectTo(request, `/?auth_error=${encodeURIComponent('登录状态校验失败，请重试')}`, config), 302),
      cookies.clearFlow(request),
    );
  }

  const token = await exchangeCode(request, config, code, flow.codeVerifier);
  const idClaims = token.id_token ? decodeIdTokenClaims(token.id_token) : {};
  let userInfo = idClaims;
  if (token.access_token) {
    try {
      userInfo = await fetchUserInfo(config, token.access_token);
    } catch {
      // userinfo 失败时退回 id_token claims
    }
  }
  const user = normalizeUser(userInfo, idClaims);
  // id_token 只用于登出时作为 id_token_hint，和会话一起加密存着
  const sessionToken = await createSession(config.sessionSecret, { ...user, idToken: token.id_token || '' });
  const target = flow.returnTo && flow.returnTo.startsWith('/') ? flow.returnTo : '/';
  return withCookies(
    Response.redirect(redirectTo(request, target, config), 302),
    [cookies.setSession(request, sessionToken), cookies.clearFlow(request)],
  );
}

// 站内地址才自己跳，外站回跳地址只交给 OneID 用
function sameSite(request, target) {
  try {
    return new URL(target, request.url).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

// 登出：本站这一跳就把会话 cookie 清掉，再交给 OneID 的 fclogout 收尾。
//
// OneID 只在应用里登记过登出回跳地址时才肯把人送回 post_logout_redirect_uri，
// 没登记就回 invalid_request + Invalid post_logout_redirect_uri，把人晾在 JSON 报错页上。
// 所以先探一眼：受理了才让浏览器去 OneID，被拒就自己回首页——
// 反正 cookie 已经清了，本站已是未登录状态，点登录能重新走授权。
// 不用 POST 表单：fclogout 只收 GET，POST 回 405。
async function handleLogout(request, config) {
  const session = await readSession(request, config.sessionSecret);
  const postLogout = config.logoutRedirectUri || redirectTo(request, '/', config);
  const idTokenHint = (session && session.idToken) || '';
  const logoutUrl = await buildLogoutUrl(config, { idTokenHint, postLogoutRedirect: postLogout });
  const backHome = sameSite(request, postLogout) ? postLogout : redirectTo(request, '/', config);
  const accepted = logoutUrl ? await logoutAccepted(logoutUrl) : false;
  return withCookies(Response.redirect(accepted ? logoutUrl : backHome, 302), cookies.clearSession(request));
}

async function handleMe(request, config, kv) {
  const session = await readSession(request, config.sessionSecret);
  const admin = await adminState(request, config, session);
  const attempts = session && config.maxAttempts > 0 ? await countAttempts(kv, session.sub) : 0;
  return ok({
    authenticated: !!session,
    user: session ? { name: session.name, username: session.username, sub: session.sub } : null,
    guest: !session && config.allowGuest,
    isAdmin: admin.isAdmin,
    rules: await publicRules(config),
    site: siteInfo(config),
    attempts,
    attemptsLeft: config.maxAttempts > 0 ? Math.max(0, config.maxAttempts - attempts) : null,
  });
}

/* ---------------- 考试 ---------------- */

// 截止时间与次数限制都在服务端再挡一次，前端隐藏入口只是体验
function examBlocked(config) {
  if (config.deadlineAt != null && Date.now() >= config.deadlineAt) {
    return fail(`本次考试已于 ${config.deadline} 截止`, 403, { code: 'EXAM_CLOSED', deadline: config.deadline });
  }
  return null;
}

/**
 * 谁在考试：登录用户用 sub 认人，游客用服务端签发的 gid。
 * owner 只用来拼试卷 key，guest 决定「不落库、不排行、不记次数」。
 */
function examOwner(session, config, guestId) {
  if (session) return { owner: session.sub, guest: false };
  if (!config.allowGuest) return null;
  return { owner: guestId || '', guest: true };
}

async function handleExamStart(request, config, kv, session) {
  // 游客首次开考由服务端发 gid，之后随请求带回来（前端存 localStorage）
  const body = await readJSON(request);
  const who = examOwner(session, config, typeof body.guestId === 'string' ? body.guestId.trim() : '');
  if (!who) return fail('请先登录', 401);
  if (who.guest && !who.owner) who.owner = randomString(12);

  const blocked = examBlocked(config);
  if (blocked) return blocked;

  // 游客没有稳定身份，次数限制无从统计，按不限处理
  if (!who.guest && config.maxAttempts > 0 && await countAttempts(kv, session.sub) >= config.maxAttempts) {
    return fail(`每人最多参加 ${config.maxAttempts} 次考试，你已达到上限`, 403, { code: 'ATTEMPTS_EXCEEDED' });
  }

  const questions = await drawQuestions(config.questionCount);
  const startedAt = Date.now();
  const rules = await publicRules(config);
  const paper = {
    sub: session ? session.sub : null,
    name: session ? session.name : null,
    guest: who.guest,
    questions,
    startedAt,
    expiresAt: startedAt + config.durationMinutes * 60 * 1000,
    rules,
  };
  const key = who.guest ? guestPaperKey(who.owner) : paperKey(who.owner);
  await kv.put(key, JSON.stringify(paper), { expirationTtl: config.durationMinutes * 60 + 3600 });
  return ok({
    paperId: key,
    guest: who.guest,
    // 游客下次交卷/取卷要把 gid 带回来，登录用户不需要
    guestId: who.guest ? who.owner : null,
    startedAt: paper.startedAt,
    expiresAt: paper.expiresAt,
    durationSeconds: config.durationMinutes * 60,
    rules,
    questions: questions.map((q) => ({ ...q, originalId: q.id })),
    total: questions.length,
  });
}

async function handleExamQuestions(config, kv, session, params) {
  const who = examOwner(session, config, params.get('guestId') || '');
  if (!who) return fail('请先登录', 401);
  if (who.guest && !who.owner) return fail('请先开始考试', 409);
  const raw = await kv.get(who.guest ? guestPaperKey(who.owner) : paperKey(who.owner), { type: 'json' });
  if (!raw) return fail('未找到进行中的考试，请重新开始', 409);

  // 只返回当前题目对应的题号，客户端可用 ?index=N 逐题拉取；不传则返回整卷
  const index = params.get('index');
  if (index !== null) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= raw.questions.length) return fail('题目序号越界', 400);
    return ok({
      question: { ...raw.questions[i], originalId: raw.questions[i].id },
      index: i,
      total: raw.questions.length,
      startedAt: raw.startedAt,
      expiresAt: raw.expiresAt,
    });
  }
  return ok({
    questions: raw.questions.map((q) => ({ ...q, originalId: q.id })),
    total: raw.questions.length,
    startedAt: raw.startedAt,
    expiresAt: raw.expiresAt,
    durationSeconds: config.durationMinutes * 60,
  });
}

async function handleExamSubmit(request, config, kv, session) {
  const body = await readJSON(request);
  const who = examOwner(session, config, typeof body.guestId === 'string' ? body.guestId.trim() : '');
  if (!who) return fail('请先登录', 401);

  const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
  const key = who.guest && who.owner ? guestPaperKey(who.owner) : (who.guest ? null : paperKey(who.owner));
  const raw = key ? await kv.get(key, { type: 'json' }) : null;
  let questions = raw && Array.isArray(raw.questions) ? raw.questions : null;

  // 用时以服务端记录的开始时间为准；试卷缺失时用客户端回传值兜底，
  // 但不允许晚于当前时间，避免伪造开始时间把用时报短。
  const now = Date.now();
  let startedAt = raw && raw.startedAt ? raw.startedAt : Number(body.startedAt) || now;
  if (!(startedAt > 0) || startedAt > now) startedAt = now;

  if (!questions) {
    // 游客每一份试卷都必须有服务端记录，否则不认这次作答（防止无限制刷分）
    if (who.guest) return fail('未找到进行中的考试，请重新开始', 409);
    // 试卷丢失（KV 过期/跨节点延迟）时，用客户端回传的题号还原，判分仍以服务端题库为准
    const ids = Array.isArray(body.questionIds) ? body.questionIds.map(Number).filter(Number.isInteger) : [];
    questions = ids.map((id) => ({ id }));
    if (!questions.length) return fail('未找到进行中的考试，请重新开始', 409);
  }

  // 超时交卷只收「自动交卷」这一次：前端到点会自己提交，这里给 90 秒的传输余量
  const deadline = (raw && raw.expiresAt ? raw.expiresAt : startedAt + config.durationMinutes * 60 * 1000) + 90 * 1000;
  if (now > deadline) {
    if (key) await kv.delete(key);
    return fail('考试已超时，本次作答未记录，请重新开始', 409, { code: 'EXAM_TIMEOUT' });
  }

  const finishedAt = now;
  const graded = await gradeSubmission(questions, answers, config.pointsPerQuestion);
  const durationMs = Math.max(0, finishedAt - startedAt);
  const passed = graded.score >= config.passScore;

  // 逐题解析只在交卷这一刻可靠（记录可能不落库），所以是否回答案由 EXAM_SHOW_ANSWER 决定
  const details = graded.details.map((d) => ({
    id: d.id,
    question: d.question,
    options: d.options,
    correctAnswer: config.showAnswer ? d.correctAnswer : null,
    submittedAnswer: d.submittedAnswer,
    isCorrect: config.showAnswer ? d.isCorrect : null,
  }));

  // 游客与「不留存记录」走同一条路：成绩只出现在这次交卷响应里，之后谁也翻不回来
  const persist = !who.guest && config.keepRecords;
  const result = {
    score: graded.score,
    correctCount: graded.correctCount,
    total: graded.details.length,
    passScore: config.passScore,
    totalScore: graded.details.length * config.pointsPerQuestion,
    passed,
    startedAt,
    finishedAt,
    durationMs,
    showAnswer: config.showAnswer,
    showRanking: config.showRanking,
    // 游客成绩不进排名、也不占次数，前端据此隐藏相关入口
    guest: who.guest,
    persisted: persist,
    details,
    recordId: null,
  };

  if (persist) {
    const record = await saveRecord(kv, {
      sub: session.sub,
      name: session.name,
      username: session.username,
      startedAt,
      finishedAt,
      durationMs,
      score: graded.score,
      correctCount: graded.correctCount,
      total: graded.details.length,
      passScore: config.passScore,
      passed,
      details: graded.details,
    });
    result.recordId = record.id;
  }

  // 交卷后清掉进行中的试卷，防止重复提交
  if (key) await kv.delete(key);
  return ok(result);
}

/* ---------------- 管理后台 ---------------- */

// 同一 IP 连续试错就锁一会儿，挡住拿字典撞密码的
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const loginFails = new Map();

function clientIp(request) {
  const h = request.headers;
  return (h.get('cf-connecting-ip') || h.get('x-forwarded-for') || h.get('x-real-ip') || '')
    .split(',')[0]
    .trim() || 'unknown';
}

function loginLocked(ip, now) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (rec.lockedUntil && rec.lockedUntil > now) return Math.ceil((rec.lockedUntil - now) / 1000);
  if (rec.lockedUntil && rec.lockedUntil <= now) loginFails.delete(ip);
  return 0;
}

function recordLoginFailure(ip, now) {
  const rec = loginFails.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_FAIL_LIMIT) rec.lockedUntil = now + LOGIN_LOCK_MS;
  loginFails.set(ip, rec);
}

async function handleAdminLogin(request, config) {
  if (!config.adminPasswordEnabled) {
    return fail('未开启密码登录', 403, { code: 'ADMIN_PASSWORD_DISABLED' });
  }
  const ip = clientIp(request);
  const now = Date.now();
  const wait = loginLocked(ip, now);
  if (wait > 0) return fail(`密码错误次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试`, 429, { code: 'ADMIN_LOGIN_LOCKED', retryAfter: wait });

  const body = await readJSON(request);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) return fail('请输入管理密码', 400);

  if (!(await verifyAdminPassword(password, config.adminPassword))) {
    recordLoginFailure(ip, now);
    return fail('管理密码不正确', 401, { code: 'ADMIN_PASSWORD_INVALID' });
  }
  loginFails.delete(ip);

  const token = await createAdminSession(config.sessionSecret);
  return withCookies(
    ok({ authenticated: true, isAdmin: true, expiresIn: ADMIN_SESSION_SECONDS }),
    cookies.setAdmin(request, token),
  );
}

async function handleAdminLogout(request) {
  return withCookies(ok({ authenticated: false }), cookies.clearAdmin(request));
}

/**
 * 当前的后台身份：OneID 白名单，或密码登录的后台会话，二者取其一。
 * 密码会话只给后台用，不代表「已登录的用户」——它没有 sub，也不该能答题。
 */
async function adminState(request, config, session) {
  if (isAdmin(session, config)) return { session, isAdmin: true, via: 'oidc' };
  if (config.adminPasswordEnabled && await readAdminSession(request, config.sessionSecret)) {
    return { session, isAdmin: true, via: 'password' };
  }
  return { session, isAdmin: false, via: null };
}

function requireAdmin(admin) {
  if (admin.isAdmin) return null;
  // 密码会话过期时 session 也可能为空，统一按未登录处理
  if (!admin.session) return fail('请先登录', 401);
  return fail('无权访问管理后台', 403);
}

async function handleAdminStats(kv, admin) {
  const denied = requireAdmin(admin);
  if (denied) return denied;
  const stats = await getStats(kv);
  const records = await listRecords(kv);
  const finished = records.filter((r) => r.finishedAt);
  const fastest = finished.reduce((a, r) => (!a || (r.durationMs ?? Infinity) < (a.durationMs ?? Infinity) ? r : a), null);
  const slowest = finished.reduce((a, r) => (!a || (r.durationMs ?? -1) > (a.durationMs ?? -1) ? r : a), null);
  return ok({
    stats: stats || { uniqueUsers: 0, attempts: 0, passed: 0, passRate: 0, avgScore: 0, maxScore: null, minScore: null, fastestMs: null, slowestMs: null },
    extra: {
      fastest: fastest ? { name: fastest.name, durationMs: fastest.durationMs, score: fastest.score, finishedAt: fastest.finishedAt } : null,
      slowest: slowest ? { name: slowest.name, durationMs: slowest.durationMs, score: slowest.score, finishedAt: slowest.finishedAt } : null,
      totalQuestions: finished.length ? finished[0].total : null,
    },
    isAdmin: true,
  });
}

async function handleAdminRecords(kv, admin) {
  const denied = requireAdmin(admin);
  if (denied) return denied;
  const records = await listRecords(kv);
  return ok({
    records: records.map((r) => ({
      id: r.id,
      name: r.name,
      username: r.username,
      score: r.score,
      correctCount: r.correctCount,
      total: r.total,
      passed: r.passed,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
    })),
    isAdmin: true,
  });
}

async function handleAdminRecord(config, kv, admin, params) {
  const denied = requireAdmin(admin);
  if (denied) return denied;
  const id = params.get('id');
  if (!id) return fail('缺少记录 id', 400);
  const record = await getRecord(kv, id);
  if (!record) return fail('记录不存在', 404);
  return ok({ record: maskDetails(record, config.showAnswer), isAdmin: true });
}
