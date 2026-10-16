// 统一响应工具

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

export function fail(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, { status });
}

export function ok(data = {}) {
  return json({ ok: true, ...data });
}

export function noContent(status = 204, headers = {}) {
  return new Response(null, { status, headers });
}

export function withCookies(response, cookieList) {
  const list = (Array.isArray(cookieList) ? cookieList : [cookieList]).filter(Boolean);
  if (!list.length) return response;
  const headers = new Headers(response.headers);
  list.forEach((c) => headers.append('set-cookie', c));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function readJSON(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) return {};
  try {
    return await request.json();
  } catch {
    return {};
  }
}
