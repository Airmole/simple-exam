// /api/* 路由分发
import { getConfig, getKV } from './config.js';
import { fail, noContent, ok, readJSON, withCookies } from './http.js';
import { cookies, createFlow, createSession, exchangeCode, fetchUserInfo, isAdmin, normalizeUser, readFlow, readSession, decodeIdTokenClaims, buildLogoutUrl, logoutAccepted } from './oidc.js';
import { drawQuestions, getBankSize } from './questions.js';
import { gradeSubmission } from './scoring.js';
import { buildRanking, countAttempts, getRecord, getStats, listRecords, maskDetails, paperKey, saveRecord } from './store.js';

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

    // ---- 考试规则 ----
    if (path === 'exam/rules') return ok({ rules: await publicRules(config) });

    const session = await readSession(request, config.sessionSecret);
    const admin = { session, isAdmin: isAdmin(session, config) };

    // ---- 考试 ----
    if (path === 'exam/start' && method === 'POST') return await handleExamStart(config, kv, session);
    if (path === 'exam/questions' && method === 'GET') return await handleExamQuestions(config, kv, session, new URL(request.url).searchParams);
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
  };
}

/** 站点品牌配置，前端据此渲染标题、Logo 与主题色 */
function siteInfo(config) {
  return {
    siteName: config.siteName,
    logo: config.siteLogo,
    brandColor: config.brandColor,
    showRanking: config.showRanking,
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
    isAdmin: admin.isAdmin,
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
  const attempts = session && config.maxAttempts > 0 ? await countAttempts(kv, session.sub) : 0;
  return ok({
    authenticated: !!session,
    user: session ? { name: session.name, username: session.username, sub: session.sub } : null,
    isAdmin: isAdmin(session, config),
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

async function handleExamStart(config, kv, session) {
  if (!session) return fail('请先登录', 401);
  const blocked = examBlocked(config);
  if (blocked) return blocked;

  if (config.maxAttempts > 0 && await countAttempts(kv, session.sub) >= config.maxAttempts) {
    return fail(`每人最多参加 ${config.maxAttempts} 次考试，你已达到上限`, 403, { code: 'ATTEMPTS_EXCEEDED' });
  }

  const questions = await drawQuestions(config.questionCount);
  const startedAt = Date.now();
  const rules = await publicRules(config);
  const paper = {
    sub: session.sub,
    name: session.name,
    questions,
    startedAt,
    expiresAt: startedAt + config.durationMinutes * 60 * 1000,
    rules,
  };
  await kv.put(paperKey(session.sub), JSON.stringify(paper), { expirationTtl: config.durationMinutes * 60 + 3600 });
  return ok({
    paperId: paperKey(session.sub),
    startedAt: paper.startedAt,
    expiresAt: paper.expiresAt,
    durationSeconds: config.durationMinutes * 60,
    rules,
    questions: questions.map((q) => ({ ...q, originalId: q.id })),
    total: questions.length,
  });
}

async function handleExamQuestions(config, kv, session, params) {
  if (!session) return fail('请先登录', 401);
  const raw = await kv.get(paperKey(session.sub), { type: 'json' });
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
  if (!session) return fail('请先登录', 401);
  const body = await readJSON(request);
  const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};

  const raw = await kv.get(paperKey(session.sub), { type: 'json' });
  let questions = raw && Array.isArray(raw.questions) ? raw.questions : null;

  // 用时以服务端记录的开始时间为准；试卷缺失时用客户端回传值兜底，
  // 但不允许晚于当前时间，避免伪造开始时间把用时报短。
  const now = Date.now();
  let startedAt = raw && raw.startedAt ? raw.startedAt : Number(body.startedAt) || now;
  if (!(startedAt > 0) || startedAt > now) startedAt = now;

  if (!questions) {
    // 试卷丢失（KV 过期/跨节点延迟）时，用客户端回传的题号还原，判分仍以服务端题库为准
    const ids = Array.isArray(body.questionIds) ? body.questionIds.map(Number).filter(Number.isInteger) : [];
    questions = ids.map((id) => ({ id }));
    if (!questions.length) return fail('未找到进行中的考试，请重新开始', 409);
  }

  // 超时交卷只收「自动交卷」这一次：前端到点会自己提交，这里给 90 秒的传输余量
  const deadline = (raw && raw.expiresAt ? raw.expiresAt : startedAt + config.durationMinutes * 60 * 1000) + 90 * 1000;
  if (now > deadline) {
    await kv.delete(paperKey(session.sub));
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
    details,
    recordId: null,
  };

  if (config.keepRecords) {
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
  await kv.delete(paperKey(session.sub));
  return ok(result);
}

/* ---------------- 管理后台 ---------------- */

function requireAdmin(admin) {
  if (!admin.session) return fail('请先登录', 401);
  if (!admin.isAdmin) return fail('无权访问管理后台', 403);
  return null;
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
