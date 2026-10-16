// 后端接口封装

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  meta: () => request('/meta'),
  me: () => request('/auth/me'),
  rules: () => request('/exam/rules'),
  startExam: () => request('/exam/start', { method: 'POST', body: {} }),
  submitExam: (payload) => request('/exam/submit', { method: 'POST', body: payload }),
  ranking: () => request('/ranking'),
  adminStats: () => request('/admin/stats'),
  adminRecords: () => request('/admin/records'),
  adminRecord: (id) => request(`/admin/record?id=${encodeURIComponent(id)}`),
};

export function loginUrl(returnTo = location.pathname + location.search) {
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}
