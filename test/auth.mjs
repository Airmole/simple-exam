import { buildAuthorizeUrl, createFlow, createSession, readSession, isAdmin, normalizeUser, redirectUri } from '../edge-functions/api/_lib/oidc.js';
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

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
