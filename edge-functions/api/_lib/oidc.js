// 腾讯统一身份认证 OneID 的 OIDC 客户端
// 端点全部从 well-known 拉取并缓存（边缘节点内存缓存 + KV 兜底）

import { b64urlDecode, decryptJSON, encryptJSON, hmacSign, hmacVerify, randomString, sha256b64url } from './crypto.js';

const SESSION_COOKIE = 'exam_session';
const FLOW_COOKIE = 'exam_oidc_flow';
const ADMIN_COOKIE = 'exam_admin';
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 小时
const FLOW_TTL_SECONDS = 60 * 10; // 10 分钟
const ADMIN_TTL_SECONDS = 60 * 60 * 4; // 密码登录的后台会话 4 小时

let discoveryCache = null;

export async function discover(issuer) {
  if (discoveryCache && discoveryCache.issuer === issuer && discoveryCache.expiresAt > Date.now()) {
    return discoveryCache.value;
  }
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`拉取 OIDC 配置失败: ${res.status}`);
  const value = await res.json();
  discoveryCache = { issuer, value, expiresAt: Date.now() + 60 * 60 * 1000 };
  return value;
}

export function redirectUri(request, config) {
  if (config.siteUrl) return `${config.siteUrl}/api/auth/callback`;
  const u = new URL(request.url);
  return `${u.origin}/api/auth/callback`;
}

function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function cookie(name, value, { maxAge, request, path = '/' } = {}) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  return `${parts.join('; ')}${secure}`;
}

export const cookies = {
  sessionName: SESSION_COOKIE,
  flowName: FLOW_COOKIE,
  adminName: ADMIN_COOKIE,
  read: parseCookies,
  setSession(request, token) {
    return cookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_SECONDS, request });
  },
  setFlow(request, token) {
    return cookie(FLOW_COOKIE, token, { maxAge: FLOW_TTL_SECONDS, request });
  },
  clearSession(request) {
    return cookie(SESSION_COOKIE, '', { maxAge: 0, request });
  },
  clearFlow(request) {
    return cookie(FLOW_COOKIE, '', { maxAge: 0, request });
  },
  setAdmin(request, token) {
    return cookie(ADMIN_COOKIE, token, { maxAge: ADMIN_TTL_SECONDS, request });
  },
  clearAdmin(request) {
    return cookie(ADMIN_COOKIE, '', { maxAge: 0, request });
  },
};

/* ---------- 会话 ---------- */

export async function createSession(secret, user) {
  const body = {
    ...user,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_SECONDS * 1000,
    nonce: randomString(8),
  };
  const payload = await encryptJSON(body, secret);
  const sig = await hmacSign(payload, secret);
  return `${payload}.${sig}`;
}

export async function readSession(request, secret) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!(await hmacVerify(payload, sig, secret))) return null;
  const body = await decryptJSON(payload, secret);
  if (!body || !body.exp || body.exp < Date.now()) return null;
  return body;
}

/* ---------- 授权码流程 ---------- */

export async function buildAuthorizeUrl(request, config, state, codeChallenge) {
  const meta = await discover(config.oidcIssuer);
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.oidcClientId);
  url.searchParams.set('redirect_uri', redirectUri(request, config));
  url.searchParams.set('scope', config.oidcScopes);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function createFlow(request, config, returnTo) {
  const state = randomString(16);
  const codeVerifier = randomString(32);
  const codeChallenge = await sha256b64url(codeVerifier);
  const flow = { state, codeVerifier, returnTo: returnTo || '/', exp: Date.now() + FLOW_TTL_SECONDS * 1000 };
  const payload = await encryptJSON(flow, config.sessionSecret);
  const sig = await hmacSign(payload, config.sessionSecret);
  return { token: `${payload}.${sig}`, authorizeUrl: await buildAuthorizeUrl(request, config, state, codeChallenge), state };
}

export async function readFlow(request, config) {
  const token = parseCookies(request)[FLOW_COOKIE];
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  if (!(await hmacVerify(payload, token.slice(idx + 1), config.sessionSecret))) return null;
  const flow = await decryptJSON(payload, config.sessionSecret);
  if (!flow || flow.exp < Date.now()) return null;
  return flow;
}

// 客户端认证方式（RFC 6749 §2.3.1）。OneID 对两种方式的支持因应用而异：
// - basic：Authorization: Basic base64(urlencode(id):urlencode(secret))，凭据本身必须是 ASCII
// - post：client_id/client_secret 直接放进表单 body，躲开 Basic 的 ASCII 与反代改 header 两类风险
// 配置里显式指定优先，否则先 basic；遇到 invalid_client 说明凭据没被认下来，换另一种再试一次。
const CLIENT_AUTH_METHODS = ['basic', 'post'];

export function clientAuthMethods(config) {
  const preferred = String(config.oidcClientAuthMethod || '').trim().toLowerCase();
  const methods = CLIENT_AUTH_METHODS.filter((m) => m !== preferred);
  return preferred ? [preferred, ...methods] : methods;
}

/**
 * RFC 6749 §2.3.1：client_id/client_secret 先 form-urlencoded 再拼成 Basic 凭据。
 * Basic 只保证 ASCII 可还原，btoa 遇到非 ASCII 会直接抛错，所以按 UTF-8 字节转 base64。
 * 编码放不进 header（视作失败）时返回 null，交给调用方换用 body 认证。
 */
function basicAuthHeader(clientId, clientSecret) {
  const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  if (!/^[\x20-\x7e]*$/.test(pair)) return null;
  return `Basic ${btoa(pair)}`;
}

function isInvalidClient(res, text) {
  if (res.status !== 401 && res.status !== 400) return false;
  return /invalid_client/.test(text);
}

async function requestToken(meta, form, method, config) {
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  let params = new URLSearchParams(form);
  if (method === 'basic') {
    const auth = basicAuthHeader(config.oidcClientId, config.oidcClientSecret);
    if (!auth) return null; // 凭据里带非 ASCII，Basic 编不出来
    headers.authorization = auth;
  } else {
    params.set('client_id', config.oidcClientId);
    params.set('client_secret', config.oidcClientSecret);
  }
  // body 必须是字符串：URLSearchParams 在 Edge 运行时不算合法 BodyInit，
  // fetch 构造 Request 时就会抛「only String/... is allowed as the body initializer」。
  const res = await fetch(meta.token_endpoint, { method: 'POST', headers, body: params.toString() });
  const text = await res.text();
  return { res, text };
}

export async function exchangeCode(request, config, code, codeVerifier) {
  const meta = await discover(config.oidcIssuer);
  const form = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(request, config),
    code_verifier: codeVerifier,
  };

  const attempts = [];
  let last = null;
  for (const method of clientAuthMethods(config)) {
    const sent = await requestToken(meta, form, method, config);
    if (!sent) {
      attempts.push(`${method}: 客户端凭据含非 ASCII 字符，无法放进 Basic 头`);
      continue;
    }
    const { res, text } = sent;
    if (res.ok) return JSON.parse(text);
    last = { res, text };
    if (!isInvalidClient(res, text)) break; // 不是凭据问题，换方式也没用
    attempts.push(`${method}: ${res.status}`);
  }

  const detail = last ? `${last.res.status} ${last.text.slice(0, 300)}` : '';
  const tried = attempts.length ? `（已尝试 ${attempts.join('，')}）` : '';
  throw new Error(`换取 token 失败: ${detail || '客户端认证方式均不可用'}${tried}`);
}

export async function fetchUserInfo(config, accessToken) {
  const meta = await discover(config.oidcIssuer);
  const res = await fetch(meta.userinfo_endpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`获取用户信息失败: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// 尽量从 id_token 里解出 claims（不验签也能拿到 sub/name，用于日志兜底）
export function decodeIdTokenClaims(idToken) {
  try {
    const part = String(idToken).split('.')[1];
    return JSON.parse(new TextDecoder().decode(b64urlDecode(part)));
  } catch {
    return {};
  }
}

// 登出端点兜底（issuer 形如 https://oauth2.account.tencent.com/authz/oidc/v2/<app_id>）：
// - 真实可用的 fclogout 在 /authz/oidc/v2/<app_id>/fclogout，即 issuer + /fclogout；
// - 砍掉 /oidc/ 段拼出的 /authz/fclogout 并不存在，OneID 网关直接回 404 page not found。
// PR #14 就是错信了这条兜底地址才继续白屏，这里改回 issuer 下的端点。
function fallbackLogoutEndpoint(issuer) {
  return `${issuer.replace(/\/+$/, '')}/fclogout`;
}

// well-known 的 end_session_endpoint 只认绝对地址；兼容 issuer 少了 /authz/ 这类写法，
// 拉取失败或字段缺失都回落到 issuer 下的 fclogout。
async function logoutEndpoint(config) {
  try {
    const meta = await discover(config.oidcIssuer);
    const endpoint = meta && meta.end_session_endpoint;
    return typeof endpoint === 'string' && /^https?:\/\//i.test(endpoint) ? endpoint : null;
  } catch {
    return null;
  }
}

// 组装 OneID 登出地址。
// OneID 的 fclogout 只认 GET，且要求三件事一起给：client_id、post_logout_redirect_uri、id_token_hint，
// 少一个就 invalid_request 白屏（Missing client_id）。
// 优先级仍是 well-known 的 end_session_endpoint，但只在它是本 issuer 路径下的绝对地址时才采信。
export async function buildLogoutUrl(config, { idTokenHint, postLogoutRedirect } = {}) {
  if (!config.oidcIssuer) return null;
  const endpoint = (await logoutEndpoint(config)) || fallbackLogoutEndpoint(config.oidcIssuer);
  const url = new URL(endpoint);
  if (config.oidcClientId) url.searchParams.set('client_id', config.oidcClientId);
  if (postLogoutRedirect) url.searchParams.set('post_logout_redirect_uri', postLogoutRedirect);
  if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
  return url.toString();
}

// OneID 只在应用里登记过登出回跳地址时才认 post_logout_redirect_uri：
// 没登记就回 invalid_request + Invalid post_logout_redirect_uri，页面停在一坨 JSON 上。
// 这里先探一次，让调用方决定是去 OneID 还是自己回站内。
// 拿不到明确答复（网络抖动、5xx）就当作受理，别因为探测失败挡了正常登出。
export async function logoutAccepted(logoutUrl) {
  try {
    const res = await fetch(logoutUrl, { method: 'GET', redirect: 'manual' });
    return res.status < 400;
  } catch {
    return true;
  }
}

/* ---------- 密码登录的后台会话 ---------- */

// 不和 OneID 会话混在一起：退出登录不该顺手把人踢出后台，反之亦然。
export const ADMIN_SESSION_SECONDS = ADMIN_TTL_SECONDS;

export async function createAdminSession(secret) {
  const payload = await encryptJSON({ kind: 'admin', iat: Date.now(), exp: Date.now() + ADMIN_TTL_SECONDS * 1000 }, secret);
  return `${payload}.${await hmacSign(payload, secret)}`;
}

export async function readAdminSession(request, secret) {
  const token = parseCookies(request)[ADMIN_COOKIE];
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  if (!(await hmacVerify(payload, token.slice(idx + 1), secret))) return null;
  const body = await decryptJSON(payload, secret);
  if (!body || body.kind !== 'admin' || !body.exp || body.exp < Date.now()) return null;
  return body;
}

/**
 * 定长比较，别让响应时间泄漏密码前缀。
 * 先各自 SHA-256 再逐字节比，长度不同也就自然摊平了。
 */
export async function verifyAdminPassword(input, expected) {
  if (!expected) return false;
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input ?? ''))));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(expected))));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function normalizeUser(userInfo, idClaims) {
  const claims = { ...idClaims, ...userInfo };
  const sub = String(claims.sub || '');
  const name = claims.name || claims.preferred_username || claims.email || sub || '未知用户';
  return {
    sub,
    name,
    username: claims.preferred_username || '',
    email: claims.email || '',
    mobile: claims.mobile || '',
    departmentIds: claims.department_ids || [],
  };
}

export function isAdmin(user, config) {
  if (!user) return false;
  if (!config.adminUsers.length) return false;
  const candidates = [user.sub, user.username, user.email, user.mobile, user.name]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  return candidates.some((c) => config.adminUsers.includes(c));
}
