// 运行时配置：全部来自环境变量（EdgeOne Makers 控制台配置，或用 .env 本地调试）
// 未显式配置的项使用默认值。

export const DEFAULTS = {
  SITE_NAME: '通用单选题考试系统',
  SITE_LOGO: 'Q',
  BRAND_COLOR: '#0f5fff',
  EXAM_QUESTION_COUNT: '10',
  EXAM_POINTS_PER_QUESTION: '10',
  EXAM_PASS_SCORE: '60',
  EXAM_DURATION_MINUTES: '30',
  EXAM_MAX_ATTEMPTS: '0',
  EXAM_SHOW_RANKING: 'true',
  EXAM_SHOW_ANSWER: 'true',
  EXAM_KEEP_RECORDS: 'true',
  EXAM_DEADLINE: '',
  EXAM_ALLOW_GUEST: 'false',
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// 允许为 0 的计数（如「不限次数」用 0 表示）
const nonNegative = (v, fallback) => {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const bool = (v, fallback) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return fallback;
  return !['0', 'false', 'off', 'no'].includes(s);
};

// 管理后台密码最短长度：太短等于没设，直接按未配置处理
export const MIN_ADMIN_PASSWORD_LENGTH = 6;

const ORIGIN_PATTERN = /^https?:\/\/[0-9A-Za-z.-]+(:\d+)?(\/.*)?$/;

// 管理后台白名单：支持 OneID 用户名（preferred_username）、邮箱、手机号或 sub，逗号分隔
const parseAdminList = (raw) =>
  String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function getConfig(env) {
  const e = env || {};
  const questionCount = num(e.EXAM_QUESTION_COUNT, Number(DEFAULTS.EXAM_QUESTION_COUNT));
  const pointsPerQuestion = num(e.EXAM_POINTS_PER_QUESTION, Number(DEFAULTS.EXAM_POINTS_PER_QUESTION));
  // 站点地址：只接受 http(s) 绝对地址，填错（如漏了协议、写成域名）就当作未配置，
  // 由调用方回退到请求 origin，否则重定向会拼出坏地址。
  const siteUrl = String(e.SITE_URL || '').trim().replace(/\/+$/, '');
  const brandColor = String(e.BRAND_COLOR || '').trim();
  return {
    // 站点品牌：域名替换成自己的之后，标题、Logo、主题色都从这里来
    siteName: String(e.SITE_NAME || '').trim() || DEFAULTS.SITE_NAME,
    siteLogo: String(e.SITE_LOGO || '').trim() || DEFAULTS.SITE_LOGO,
    brandColor: /^#[0-9a-fA-F]{3,8}$/.test(brandColor) ? brandColor : DEFAULTS.BRAND_COLOR,
    siteUrl: ORIGIN_PATTERN.test(siteUrl) ? siteUrl : '',
    // 登出后回跳地址，必须是 OneID 应用里登记过的那个；留空则回站点首页
    logoutRedirectUri: (e.OIDC_LOGOUT_REDIRECT_URI || '').trim(),
    // 腾讯 OneID OIDC
    oidcIssuer: e.OIDC_ISSUER || '',
    oidcClientId: e.OIDC_CLIENT_ID || '',
    oidcClientSecret: e.OIDC_CLIENT_SECRET || '',
    // 客户端认证方式：basic（Authorization 头）或 post（表单里带 client_secret）
    // 留空则先试 basic，OneID 回 invalid_client 时自动换 post
    oidcClientAuthMethod: e.OIDC_CLIENT_AUTH_METHOD || '',
    oidcScopes: e.OIDC_SCOPES || 'openid profile',
    // 考试规则
    questionCount,
    pointsPerQuestion,
    totalScore: questionCount * pointsPerQuestion,
    passScore: num(e.EXAM_PASS_SCORE, Number(DEFAULTS.EXAM_PASS_SCORE)),
    durationMinutes: num(e.EXAM_DURATION_MINUTES, Number(DEFAULTS.EXAM_DURATION_MINUTES)),
    // 0 表示不限次数
    maxAttempts: nonNegative(e.EXAM_MAX_ATTEMPTS, Number(DEFAULTS.EXAM_MAX_ATTEMPTS)),
    // 截止时间按北京时间（UTC+8）解析，形如 2026-12-31 23:59；留空表示不限
    deadline: (e.EXAM_DEADLINE || '').trim(),
    deadlineAt: parseDeadline(e.EXAM_DEADLINE),
    showRanking: bool(e.EXAM_SHOW_RANKING, DEFAULTS.EXAM_SHOW_RANKING === 'true'),
    // 交卷后是否把正确答案与逐题解析回给前端
    showAnswer: bool(e.EXAM_SHOW_ANSWER, DEFAULTS.EXAM_SHOW_ANSWER === 'true'),
    // 是否把答题记录写入 KV（关闭后成绩与解析只在交卷那一刻返回）
    keepRecords: bool(e.EXAM_KEEP_RECORDS, DEFAULTS.EXAM_KEEP_RECORDS === 'true'),
    // 是否允许不登录答题：游客答完即出分，但不落库、不参与统计与排名
    allowGuest: bool(e.EXAM_ALLOW_GUEST, DEFAULTS.EXAM_ALLOW_GUEST === 'true'),
    // 管理后台密码：配置后即可用密码登入后台，无需 OneID。
    // 至少 6 位，太短按未配置处理；ADMIN_PASSWORD_LOGIN=false 可整体关掉密码入口。
    adminPassword: String(e.ADMIN_PASSWORD || '').trim(),
    adminPasswordEnabled: String(e.ADMIN_PASSWORD || '').trim().length >= MIN_ADMIN_PASSWORD_LENGTH
      && bool(e.ADMIN_PASSWORD_LOGIN, true),
    // 会话签名密钥，未配置则回退到客户端密钥
    sessionSecret: e.SESSION_SECRET || e.OIDC_CLIENT_SECRET || 'insecure-dev-secret',
    // 管理后台白名单
    adminUsers: parseAdminList(e.ADMIN_USERS),
    // KV 绑定变量名（控制台绑定时填写的运行时变量名）
    kvBinding: e.KV_BINDING || 'EXAM_KV',
  };
}

/** 把 `2026-12-31 23:59`（UTC+8）解析成毫秒时间戳，解析不出返回 null */
export function parseDeadline(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh = '0', mm = '0', ss = '0'] = m;
  // Date.UTC 用 UTC 算，再回退 8 小时即为北京时间(UTC+8)对应的真实时刻
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  return utc - 8 * 3600 * 1000;
}

function looksLikeKV(v) {
  return !!v && typeof v.get === 'function' && typeof v.put === 'function' && typeof v.delete === 'function';
}

/**
 * 取 KV 绑定。
 *
 * EdgeOne Makers 把「绑定命名空间」时填写的变量名注入为运行时**全局变量**，
 * 官方示例直接写 `my_kv.get(...)`，它并不在 `context.env` 上（env 只有环境变量），
 * 所以 `env.EXAM_KV` 永远取不到东西。
 *
 * 这里按三条路径依次尝试，兼容其他运行时把绑定挂在 env 上的情况：
 * 1. 全局变量（EdgeOne 实际行为）
 * 2. env[绑定名]
 * 3. env.EXAM_KV 兜底
 */
export function getKV(env, config) {
  const names = [...new Set([config.kvBinding, 'EXAM_KV'].filter(Boolean))];
  const candidates = [];
  for (const name of names) {
    // eslint-disable-next-line no-undef
    candidates.push([name, globalThis[name]]);
    candidates.push([`env.${name}`, (env || {})[name]]);
  }
  for (const [, value] of candidates) {
    if (looksLikeKV(value)) return value;
  }
  const seen = candidates
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([label, v]) => `${label}(type=${typeof v})`);
  const hint = seen.length ? `当前读到的值：${seen.join(', ')}` : '运行时没有读到任何同名绑定';
  throw new Error(
    `未找到 KV 绑定：请在项目「KV 存储」中绑定命名空间，并把变量名设为 ${config.kvBinding}（${hint}）`,
  );
}
