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
    // 腾讯 OneID OIDC
    oidcIssuer: e.OIDC_ISSUER || '',
    oidcClientId: e.OIDC_CLIENT_ID || '',
    oidcClientSecret: e.OIDC_CLIENT_SECRET || '',
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

export function getKV(env, config) {
  const kv = (env || {})[config.kvBinding] || (env || {}).EXAM_KV;
  if (!kv) throw new Error(`未找到 KV 绑定，请在项目中绑定命名空间并把变量名设为 ${config.kvBinding}`);
  return kv;
}
