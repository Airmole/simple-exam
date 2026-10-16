// 本地开发服务器：托管 public/ 静态资源，并把 /api/* 交给 Edge Function 路由
// 附带一个 mock OIDC Provider，用于在没有真实 OneID 的情况下跑通登录流程。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockKV } from './mock-kv.js';
import { handleApi } from '../edge-functions/api/_lib/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8787);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const kv = createMockKV();
const ENV = {
  EXAM_KV: kv,
  SESSION_SECRET: 'dev-session-secret',
  SITE_URL: ORIGIN,
  OIDC_ISSUER: `${ORIGIN}/mock-oidc`,
  OIDC_CLIENT_ID: 'dev-client',
  OIDC_CLIENT_SECRET: 'dev-secret',
  OIDC_SCOPES: 'openid profile',
  ADMIN_USERS: process.env.ADMIN_USERS || 'admin',
  EXAM_QUESTION_COUNT: '50',
  EXAM_POINTS_PER_QUESTION: '2',
  EXAM_PASS_SCORE: '80',
  EXAM_DURATION_MINUTES: process.env.EXAM_DURATION_MINUTES || '60',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const users = {
  code_admin: { sub: 'u_admin', name: '张管理', preferred_username: 'admin', email: 'admin@corp.com' },
  code_student: { sub: 'u_stu1', name: '李四', preferred_username: 'lisi', email: 'lisi@corp.com' },
  code_student2: { sub: 'u_stu2', name: '王五', preferred_username: 'wangwu', email: 'wangwu@corp.com' },
};
const issuedCodes = new Map();
const issuedTokens = new Map();

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, ORIGIN);
  let filePath = path.join(PUBLIC_DIR, decodeURIComponent(url.pathname));
  if (url.pathname === '/' || url.pathname === '') filePath = path.join(PUBLIC_DIR, 'index.html');
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC_DIR, 'index.html');
  const ext = path.extname(filePath);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(filePath));
}

async function handleMockOidc(req, res) {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === '/mock-oidc/.well-known/openid-configuration') {
    return json(res, {
      issuer: ENV.OIDC_ISSUER,
      authorization_endpoint: `${ENV.OIDC_ISSUER}/authorize`,
      token_endpoint: `${ENV.OIDC_ISSUER}/token`,
      userinfo_endpoint: `${ENV.OIDC_ISSUER}/userinfo`,
      end_session_endpoint: `${ENV.OIDC_ISSUER}/fclogout`,
    });
  }
  if (url.pathname === '/mock-oidc/authorize') {
    // 直接签发授权码并以 user 查询参数选择模拟用户，代替真实登录页
    const who = url.searchParams.get('user') || 'code_student';
    const code = `code_${who}_${Date.now()}`;
    issuedCodes.set(code, { ...users[who], redirect_uri: url.searchParams.get('redirect_uri') });
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') || '');
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (url.pathname === '/mock-oidc/token') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    const info = issuedCodes.get(params.get('code'));
    if (!info) return json(res, { error: 'invalid_grant' }, 400);
    issuedCodes.delete(params.get('code'));
    const access = `at_${Math.random().toString(36).slice(2)}`;
    issuedTokens.set(access, info);
    return json(res, { access_token: access, token_type: 'Bearer', id_token: 'x.y.z', expires_in: 3600 });
  }
  if (url.pathname === '/mock-oidc/userinfo') {
    const auth = req.headers.authorization || '';
    const info = issuedTokens.get(auth.replace(/^Bearer\s+/i, ''));
    if (!info) return json(res, { error: 'invalid_token' }, 401);
    const { redirect_uri, ...user } = info;
    void redirect_uri;
    return json(res, user);
  }
  if (url.pathname === '/mock-oidc/fclogout') {
    res.writeHead(302, { location: url.searchParams.get('post_logout_redirect_uri') || '/' });
    return res.end();
  }
  res.writeHead(404);
  return res.end('mock oidc: not found');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, ORIGIN);
    if (url.pathname.startsWith('/mock-oidc')) return await handleMockOidc(req, res);
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyBuf = Buffer.concat(chunks);
      const request = new Request(`${ORIGIN}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf,
        duplex: 'half',
      });
      const response = await handleApi({ request, env: ENV, params: {} });
      const headers = {};
      response.headers.forEach((v, k) => {
        if (k.toLowerCase() === 'set-cookie') {
          headers[k] = headers[k] ? [].concat(headers[k], v) : v;
        } else headers[k] = v;
      });
      const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : undefined;
      res.writeHead(response.status, setCookies ? { ...headers, 'set-cookie': setCookies } : headers);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    return await serveStatic(req, res);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`dev server: ${ORIGIN}`);
  console.log(`mock 登录：${ORIGIN}/api/auth/login   （默认李四；? 后可用 user=code_admin 切管理员）`);
  console.log('登录后可在 /mock-oidc/authorize 前拼 user=code_admin 模拟管理员');
});
