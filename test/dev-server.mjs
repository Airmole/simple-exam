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
// 下面的环境变量都能从命令行覆盖，例如 EXAM_DEADLINE='2020-01-01 00:00' 可看已截止界面
const ORIGIN = `http://127.0.0.1:${PORT}`;

// EdgeOne 把 KV 绑定注入为全局变量，本地照着实情模拟，别在 env 上放一份假的
const kv = createMockKV();
globalThis.EXAM_KV = kv;
const ENV = {
  SESSION_SECRET: 'dev-session-secret',
  SITE_URL: ORIGIN,
  OIDC_ISSUER: `${ORIGIN}/mock-oidc`,
  OIDC_CLIENT_ID: 'dev-client',
  OIDC_CLIENT_SECRET: 'dev-secret',
  OIDC_SCOPES: 'openid profile',
  // 留空则回站点首页；填上本地 mock 登记过的地址可验证「去 OneID 再跳回来」
  OIDC_LOGOUT_REDIRECT_URI: process.env.OIDC_LOGOUT_REDIRECT_URI || '',
  ADMIN_USERS: process.env.ADMIN_USERS || 'admin',
  // 站点品牌与考试规则：都能用环境变量在本地先试一遍
  SITE_NAME: process.env.SITE_NAME || '单选题考试系统',
  SITE_LOGO: process.env.SITE_LOGO || 'Q',
  BRAND_COLOR: process.env.BRAND_COLOR || '#0f5fff',
  EXAM_QUESTION_COUNT: process.env.EXAM_QUESTION_COUNT || '10',
  EXAM_POINTS_PER_QUESTION: process.env.EXAM_POINTS_PER_QUESTION || '10',
  EXAM_PASS_SCORE: process.env.EXAM_PASS_SCORE || '60',
  EXAM_DURATION_MINUTES: process.env.EXAM_DURATION_MINUTES || '30',
  EXAM_MAX_ATTEMPTS: process.env.EXAM_MAX_ATTEMPTS || '0',
  EXAM_DEADLINE: process.env.EXAM_DEADLINE || '',
  EXAM_SHOW_RANKING: process.env.EXAM_SHOW_RANKING || 'true',
  EXAM_SHOW_ANSWER: process.env.EXAM_SHOW_ANSWER || 'true',
  EXAM_KEEP_RECORDS: process.env.EXAM_KEEP_RECORDS || 'true',
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
// 已登记的登出回跳地址：照真 OneID 的规矩，没登记就回 invalid_request。
// 置空可复现线上现状（Invalid post_logout_redirect_uri），验证「被拒也退回本站」。
const LOGOUT_REDIRECTS = new Set([`${ORIGIN}/`, `${ORIGIN}/logout-done`]);
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

  // 本地验证考试截止状态：EXAM_DEADLINE='2026-12-31 23:59' node test/dev-server.mjs
  // 截止时间由 /api/site 下发，静态资源不再需要改写

  // 登出后回跳的落地页：真站点也得有这么个页面，不然 OneID 跳回来是 404
  if (url.pathname === '/logout-done' || url.pathname === '/logout-done/') {
    const page = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>已退出登录</title><link rel="stylesheet" href="/css/style.css"></head>
<body><main class="card" style="max-width:480px;margin:12vh auto">
<h1>已退出登录</h1><p class="muted">本站与身份认证侧的会话都已结束。</p>
<p><a class="btn" href="/api/auth/login">重新登录</a> <a href="/">回首页</a></p>
</main></body></html>`;
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    return res.end(page);
  }

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
    // 真 OneID 走 client_secret_basic，也接受 client_secret_post；哪种都要把凭据校验到位，
    // 否则凭据编码错了本地还是绿的（上一轮的 bug 就是这么漏掉的）。
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);

    const auth = req.headers.authorization || '';
    let creds = null;
    let method = 'none';
    if (auth.startsWith('Basic ')) {
      method = 'basic';
      // Basic 里是 urlencode 过的 id:secret（RFC 6749 §2.3.1），要解回来再比
      const pair = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const i = pair.indexOf(':');
      if (i > 0) {
        try {
          creds = [decodeURIComponent(pair.slice(0, i)), decodeURIComponent(pair.slice(i + 1))];
        } catch {
          creds = null;
        }
      }
    } else if (params.has('client_secret')) {
      method = 'post';
      creds = [params.get('client_id'), params.get('client_secret')];
    }

    if (!creds || creds[0] !== ENV.OIDC_CLIENT_ID || creds[1] !== ENV.OIDC_CLIENT_SECRET) {
      return json(res, {
        error: 'invalid_client',
        error_description: `Client authentication failed (method=${method})`,
      }, 401);
    }

    const info = issuedCodes.get(params.get('code'));
    if (!info) return json(res, { error: 'invalid_grant' }, 400);
    if (info.redirect_uri !== params.get('redirect_uri')) {
      return json(res, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
    }
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
    // 照真 OneID 的脾气：只收 GET，缺 client_id 或者回跳地址对不上都回 invalid_request
    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end();
    }
    const params = url.searchParams;
    if (!params.get('client_id')) {
      return json(res, {
        error: 'invalid_request',
        error_description: 'Missing client_id',
      }, 400);
    }
    const back = params.get('post_logout_redirect_uri') || '';
    if (!LOGOUT_REDIRECTS.has(back)) {
      return json(res, {
        error: 'invalid_request',
        error_description: `Invalid post_logout_redirect_uri (${back})`,
      }, 400);
    }
    res.writeHead(302, { location: params.get('post_logout_redirect_uri') });
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
