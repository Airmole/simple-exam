// 运行时配置：全部来自环境变量（EdgeOne Makers 控制台配置，或用 .env 本地调试）
// 未显式配置的项使用默认值。

const DEFAULTS = {
  EXAM_QUESTION_COUNT: '50',
  EXAM_POINTS_PER_QUESTION: '2',
  EXAM_PASS_SCORE: '80',
  EXAM_DURATION_MINUTES: '60',
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// 管理后台白名单：支持 @OneID 用户名（preferred_username）、邮箱、手机号或 sub，逗号分隔
const parseAdminList = (raw) =>
  String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function getConfig(env) {
  const e = env || {};
  const questionCount = num(e.EXAM_QUESTION_COUNT, Number(DEFAULTS.EXAM_QUESTION_COUNT));
  const pointsPerQuestion = num(e.EXAM_POINTS_PER_QUESTION, Number(DEFAULTS.EXAM_POINTS_PER_QUESTION));
  return {
    // 站点域名，用于拼接回调地址，例如 dji-exam.airmole.cn
    siteUrl: (e.SITE_URL || '').replace(/\/+$/, ''),
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
    // 会期签名密钥，未配置则回退到客户端密钥
    sessionSecret: e.SESSION_SECRET || e.OIDC_CLIENT_SECRET || 'insecure-dev-secret',
    // 管理后台白名单
    adminUsers: parseAdminList(e.ADMIN_USERS),
    // KV 绑定变量名（控制台绑定时填写的运行时变量名）
    kvBinding: e.KV_BINDING || 'EXAM_KV',
  };
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
  for (const [label, value] of candidates) {
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
