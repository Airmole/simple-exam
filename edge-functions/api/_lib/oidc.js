// 腾讯统一身份认证 OneID 的 OIDC 客户端
// 端点全部从 well-known 拉取并缓存（边缘节点内存缓存 + KV 兜底）

import { b64urlDecode, decryptJSON, encryptJSON, hmacSign, hmacVerify, randomString, sha256b64url } from './crypto.js';

const SESSION_COOKIE = 'exam_session';
const FLOW_COOKIE = 'exam_oidc_flow';
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 小时
const FLOW_TTL_SECONDS = 60 * 10; // 10 分钟

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

// RFC 6749 §2.3.1：client_id/client_secret 先 form-urlencoded 再拼成 Basic 凭据。
// Basic 的「字符集」必须是 ASCII，btoa 遇到非 ASCII 会直接抛错，所以按 UTF-8 字节转 base64。
function basicAuthHeader(clientId, clientSecret) {
  const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  const bytes = new TextEncoder().encode(pair);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

export async function exchangeCode(request, config, code, codeVerifier) {
  const meta = await discover(config.oidcIssuer);
  // 必须是字符串 body。URLSearchParams 在部分 Edge 运行时里不会被识别为合法 BodyInit，
  // 会被 fetch 拒成「only String/ArrayBuffer/... is allowed as the body initializer」。
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(request, config),
    code_verifier: codeVerifier,
    client_id: config.oidcClientId,
  }).toString();
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      authorization: basicAuthHeader(config.oidcClientId, config.oidcClientSecret),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`换取 token 失败: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
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

export async function buildLogoutUrl(config, idTokenHint, postLogoutRedirect) {
  if (!config.oidcIssuer) return null;
  // 优先使用 well-known 的 end_session_endpoint，取不到时退回 issuer + /fclogout
  let endpoint = `${config.oidcIssuer.replace(/\/+$/, '')}/fclogout`;
  try {
    const meta = await discover(config.oidcIssuer);
    if (meta.end_session_endpoint) endpoint = meta.end_session_endpoint;
  } catch {
    // 发现失败不影响登出，用兜底地址
  }
  const url = new URL(endpoint);
  if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
  if (postLogoutRedirect) url.searchParams.set('post_logout_redirect_uri', postLogoutRedirect);
  return url.toString();
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
