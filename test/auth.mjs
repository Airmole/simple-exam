import { buildAuthorizeUrl, buildLogoutUrl, clientAuthMethods, createFlow, createSession, readSession, isAdmin, normalizeUser, redirectUri, exchangeCode } from '../edge-functions/api/_lib/oidc.js';
import { hmacSign, hmacVerify, encryptJSON, decryptJSON, sha256b64url, b64urlEncode } from '../edge-functions/api/_lib/crypto.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const config = {
  oidcIssuer: 'https://oauth2.account.tencent.com/authz/oidc/v2/1492474500942414067',
  oidcClientId: 'test-client',
  oidcClientSecret: 'test-secret',
  oidcScopes: 'openid profile',
  siteUrl: 'https://dji-exam.airmole.cn',
  sessionSecret: 'sess-secret',
  adminUsers: ['admin', 'admin@corp.com', '+8613800000000'],
};

console.log('\n[1] 加解密与签名');
{
  const obj = { a: 1, s: '中文', list: [1, 2, 3] };
  const enc = await encryptJSON(obj, 'k');
  const dec = await decryptJSON(enc, 'k');
  check('AES-GCM 往返', JSON.stringify(dec) === JSON.stringify(obj), JSON.stringify(dec));
  check('错误密钥解不开', (await decryptJSON(enc, 'wrong')) === null);
  const sig = await hmacSign(enc, 'k');
  check('HMAC 验签通过', await hmacVerify(enc, sig, 'k'));
  check('篡改数据验签失败', (await hmacVerify(enc + 'x', sig, 'k')) === false);
  check('sha256 b64url 稳定', (await sha256b64url('abc')) === (await sha256b64url('abc')));
  check('b64url 无特殊字符', !/[+/=]/.test(b64urlEncode(new Uint8Array([251, 255, 190]))));
}

console.log('\n[2] 会话签发与读取');
{
  const req = new Request('https://x/api', {});
  const token = await createSession('sess-secret', { sub: 's1', name: '李四' });
  const req2 = new Request('https://x/api', { headers: { cookie: `exam_session=${encodeURIComponent(token)}` } });
  const sess = await readSession(req2, 'sess-secret');
  check('会话可读回', sess && sess.sub === 's1', JSON.stringify(sess));
  const bad = await readSession(req2, 'other-secret');
  check('错误密钥读不出会话', bad === null);
  const tampered = token.slice(0, -2) + 'aa';
  const req3 = new Request('https://x/api', { headers: { cookie: `exam_session=${encodeURIComponent(tampered)}` } });
  check('篡改 token 被拒', (await readSession(req3, 'sess-secret')) === null);
  const none = await readSession(new Request('https://x/api'), 'sess-secret');
  check('无 cookie 返回 null', none === null);
}

console.log('\n[3] redirect_uri 与授权地址');
{
  const req = new Request('https://dji-exam.airmole.cn/api/auth/login');
  check('使用 SITE_URL 拼接回调', redirectUri(req, config) === 'https://dji-exam.airmole.cn/api/auth/callback');
  const noSite = { ...config, siteUrl: '' };
  check('无 SITE_URL 回退到请求 origin', redirectUri(req, noSite) === 'https://dji-exam.airmole.cn/api/auth/callback');
  const url = new URL(await buildAuthorizeUrl(req, config, 'st', 'cc'));
  check('authorize 域名正确', url.origin + url.pathname === 'https://oauth2.account.tencent.com/authz/oidc/v2/1492474500942414067/authorize', url.toString());
  check('response_type=code', url.searchParams.get('response_type') === 'code');
  check('client_id 正确', url.searchParams.get('client_id') === 'test-client');
  check('scope 正确', url.searchParams.get('scope') === 'openid profile');
  check('PKCE S256', url.searchParams.get('code_challenge_method') === 'S256' && !!url.searchParams.get('code_challenge'));
  check('state 透传', url.searchParams.get('state') === 'st');
}

console.log('\n[4] 管理员白名单');
{
  check('按 sub 匹配', isAdmin({ sub: 'x', username: 'admin' }, config) === true);
  check('按 username 匹配', isAdmin({ sub: 'x', username: 'Admin' }, config) === true);
  check('按 email 匹配（大小写不敏感）', isAdmin({ sub: 'x', email: 'ADMIN@CORP.COM' }, config) === true);
  check('按手机号匹配', isAdmin({ sub: 'x', mobile: '+8613800000000' }, config) === true);
  check('非白名单被拒', isAdmin({ sub: 'x', username: 'lisi' }, config) === false);
  check('空用户被拒', isAdmin(null, config) === false);
  check('未配置白名单则无人是管理员', isAdmin({ username: 'admin' }, { ...config, adminUsers: [] }) === false);
}

console.log('\n[5] 用户信息归一化');
{
  const u = normalizeUser({ sub: 's9', preferred_username: 'zhangsan', email: 'z@c.com' }, { name: '张三' });
  check('合并 id_token 与 userinfo', u.name === '张三' && u.username === 'zhangsan' && u.email === 'z@c.com', JSON.stringify(u));
  const u2 = normalizeUser({ sub: 's9' }, {});
  check('无 name 时回退 sub', u2.name === 's9');
}

console.log('\n[6] token 请求的报文（曾经在这里 500）');
{
  // 拦一道 fetch，把真正要发出去的 init 拿下来检查，再返回假响应
  const realFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/token')) {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ access_token: 'at', id_token: 'x.y.z' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      issuer: config.oidcIssuer,
      authorization_endpoint: `${config.oidcIssuer}/authorize`,
      token_endpoint: `${config.oidcIssuer}/token`,
      userinfo_endpoint: `${config.oidcIssuer}/userinfo`,
    }), { headers: { 'content-type': 'application/json' } });
  };

  try {
    const req = new Request('https://dji-exam.airmole.cn/api/auth/callback');
    const token = await exchangeCode(req, config, 'code-1', 'verifier-1');
    check('换 token 成功', token.access_token === 'at', JSON.stringify(token));

    const body = captured && captured.init.body;
    // 真正的坑：URLSearchParams 在 Edge 运行时不被认成合法 BodyInit，fetch 直接抛
    check('body 是字符串（不是 URLSearchParams）', typeof body === 'string', `实际类型: ${Object.prototype.toString.call(body)}`);
    const params = new URLSearchParams(String(body));
    check('grant_type 正确', params.get('grant_type') === 'authorization_code');
    check('带上 code_verifier（PKCE）', params.get('code_verifier') === 'verifier-1');
    check('redirect_uri 与授权时一致', params.get('redirect_uri') === redirectUri(req, config));

    // Basic 凭据必须是「urlencoded 之后」再 base64，解开后能还原出原始 client_secret
    const auth = String((captured.init.headers || {}).authorization || (captured.init.headers || {}).get?.('authorization') || '');
    check('走 client_secret_basic', auth.startsWith('Basic '), auth);
    const decodedPair = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const [decodedId, ...rest] = decodedPair.split(':');
    check('client_id 可还原', decodeURIComponent(decodedId) === config.oidcClientId, decodedPair);
    check('client_secret 可还原', decodeURIComponent(rest.join(':')) === config.oidcClientSecret, decodedPair);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('\n[7] 客户端认证方式的兜底');
{
  const meta = {
    issuer: config.oidcIssuer,
    authorization_endpoint: `${config.oidcIssuer}/authorize`,
    token_endpoint: `${config.oidcIssuer}/token`,
    userinfo_endpoint: `${config.oidcIssuer}/userinfo`,
  };
  const realFetch = globalThis.fetch;
  let calls = [];
  // 模拟「只认 client_secret_post」的提供方：Basic 一律回 invalid_client
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith('/token')) {
      return new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } });
    }
    const headers = Object.fromEntries(
      Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const params = new URLSearchParams(String(init.body));
    const auth = headers.authorization || '';
    const creds = auth.startsWith('Basic ')
      ? Buffer.from(auth.slice(6), 'base64').toString('utf8')
      : `${params.get('client_id')}:${params.get('client_secret')}`;
    calls.push({ authorization: auth, body: String(init.body) });
    const expected = `${config.oidcClientId}:${config.oidcClientSecret}`;
    if (auth) {
      return new Response(JSON.stringify({ error: 'invalid_client' }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    }
    if (creds !== expected) {
      return new Response(JSON.stringify({ error: 'invalid_client' }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ access_token: 'at2', id_token: 'x.y.z' }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    check('默认先 basic 再 post', clientAuthMethods(config).join(',') === 'basic,post');
    check('配置可指定首选', clientAuthMethods({ ...config, oidcClientAuthMethod: 'post' }).join(',') === 'post,basic');

    const req = new Request('https://dji-exam.airmole.cn/api/auth/callback');
    const token = await exchangeCode(req, config, 'code-2', 'verifier-2');
    check('basic 被拒后改用 post 换成 token', token.access_token === 'at2', JSON.stringify(token));
    check('共发了两次请求', calls.length === 2, `实际 ${calls.length}`);
    const second = new URLSearchParams(calls[1].body);
    check('post 方式不带 Authorization 头', !calls[1].authorization, calls[1].authorization);
    check('post 方式把凭据放进表单', second.get('client_id') === config.oidcClientId && second.get('client_secret') === config.oidcClientSecret, calls[1].body);
    check('两种方式都带 PKCE verifier', calls.every((c) => new URLSearchParams(c.body).get('code_verifier') === 'verifier-2'));

    // 只认 post 的提供方 + 配置直接指定 post：只发一次
    calls = [];
    const token2 = await exchangeCode(req, { ...config, oidcClientAuthMethod: 'post' }, 'code-3', 'v3');
    check('指定 post 时一次成功', token2.access_token === 'at2' && calls.length === 1, `实际 ${calls.length} 次`);

    // 凭据本身错了就不该反复重试，也不该把 secret 泄露在错误里
    calls = [];
    let err = '';
    try {
      await exchangeCode(req, { ...config, oidcClientSecret: 'wrong' }, 'code-4', 'v4');
    } catch (e) { err = e.message; }
    check('凭据错误时抛错', /换取 token 失败/.test(err), err);
    check('报错里不含明文密钥', !err.includes('wrong'), err);
    check('凭据错误也试过两种方式', calls.length === 2, `实际 ${calls.length}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('\n[8] 登出地址');
{
  const logout = new URL(await buildLogoutUrl(config, {
    idTokenHint: 'header.payload.sig',
    postLogoutRedirect: 'https://dji-exam.airmole.cn/',
  }));
  // 回归：PR #14 把端点改成了 /authz/fclogout，OneID 回「404 page not found」
  check('端点为 issuer 下的 /fclogout', logout.origin + logout.pathname === `${config.oidcIssuer}/fclogout`, logout.toString());
  check('带 client_id（曾经缺失导致 Missing client_id）', logout.searchParams.get('client_id') === config.oidcClientId, logout.toString());
  check('带 post_logout_redirect_uri', logout.searchParams.get('post_logout_redirect_uri') === 'https://dji-exam.airmole.cn/');
  check('带 id_token_hint', logout.searchParams.get('id_token_hint') === 'header.payload.sig');

  const noHint = new URL(await buildLogoutUrl(config, { postLogoutRedirect: 'https://dji-exam.airmole.cn/' }));
  check('无 id_token_hint 时仍带 client_id', noHint.searchParams.get('client_id') === config.oidcClientId);
  check('未配 issuer 返回 null', (await buildLogoutUrl({ ...config, oidcIssuer: '' }, {})) === null);

  // well-known 给了 end_session_endpoint 时以它为准
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    issuer: 'https://id.example.com/authz/oidc/v2/app2',
    authorization_endpoint: 'https://id.example.com/authz/oidc/v2/app2/authorize',
    token_endpoint: 'https://id.example.com/authz/oidc/v2/app2/token',
    userinfo_endpoint: 'https://id.example.com/authz/oidc/v2/app2/userinfo',
    end_session_endpoint: 'https://id.example.com/authz/oidc/v2/app2/fclogout',
  }), { headers: { 'content-type': 'application/json' } });
  try {
    const issuer = 'https://id.example.com/authz/oidc/v2/app2';
    const meta = new URL(await buildAuthorizeUrl(new Request('https://dji-exam.airmole.cn/api/auth/login'), { ...config, oidcIssuer: issuer }, 's', 'c'));
    check('发现文档已就绪', meta.origin === 'https://id.example.com');
    const url = new URL(await buildLogoutUrl({ ...config, oidcIssuer: issuer }, { postLogoutRedirect: 'https://dji-exam.airmole.cn/' }));
    check('优先使用 end_session_endpoint', url.origin + url.pathname === 'https://id.example.com/authz/oidc/v2/app2/fclogout', url.toString());
    check('切换 issuer 后按新 issuer 重新发现端点', url.origin + url.pathname === 'https://id.example.com/authz/oidc/v2/app2/fclogout', url.toString());
  } finally {
    globalThis.fetch = realFetch;
  }

  // end_session_endpoint 是相对地址/缺字段时不采信，免得拼出非法 URL
  globalThis.fetch = async () => new Response(JSON.stringify({
    issuer: 'https://id.example.com/authz/oidc/v2/app3',
    authorization_endpoint: 'https://id.example.com/authz/oidc/v2/app3/authorize',
    token_endpoint: 'https://id.example.com/authz/oidc/v2/app3/token',
    userinfo_endpoint: 'https://id.example.com/authz/oidc/v2/app3/userinfo',
    end_session_endpoint: '/authz/fclogout',
  }), { headers: { 'content-type': 'application/json' } });
  try {
    const issuer = 'https://id.example.com/authz/oidc/v2/app3';
    await buildAuthorizeUrl(new Request('https://dji-exam.airmole.cn/api/auth/login'), { ...config, oidcIssuer: issuer }, 's', 'c');
    const url = new URL(await buildLogoutUrl({ ...config, oidcIssuer: issuer }, {}));
    check('相对地址的 end_session_endpoint 被忽略', url.origin + url.pathname === `${issuer}/fclogout`, url.toString());
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
