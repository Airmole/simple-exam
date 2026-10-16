// 基于 Web Crypto 的工具：base64url、HMAC 签名、AES-GCM 加解密、PKCE

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(input) {
  const bytes = typeof input === 'string' ? enc.encode(input) : new Uint8Array(input);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmacSign(data, secret) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return b64urlEncode(sig);
}

export async function hmacVerify(data, signature, secret) {
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(signature), enc.encode(data));
    return ok;
  } catch {
    return false;
  }
}

export function randomString(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64urlEncode(buf);
}

export async function sha256b64url(text) {
  return b64urlEncode(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

const AES_ALGO = 'AES-GCM';

async function aesKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: AES_ALGO }, false, ['encrypt', 'decrypt']);
}

// 用会话密钥加密敏感载荷（如 access_token），避免直接暴露在 Cookie 中
export async function encryptJSON(obj, secret) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const data = enc.encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: AES_ALGO, iv }, await aesKey(secret), data);
  return `${b64urlEncode(iv)}.${b64urlEncode(cipher)}`;
}

export async function decryptJSON(payload, secret) {
  try {
    const [ivPart, dataPart] = String(payload).split('.');
    if (!ivPart || !dataPart) return null;
    const plain = await crypto.subtle.decrypt(
      { name: AES_ALGO, iv: b64urlDecode(ivPart) },
      await aesKey(secret),
      b64urlDecode(dataPart),
    );
    return JSON.parse(dec.decode(plain));
  } catch {
    return null;
  }
}
