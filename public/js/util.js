// 通用展示工具

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v == null || v === false) return;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null || c === false) return;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  });
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 毫秒 -> 可读时长，如 1小时02分03秒 */
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const total = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}小时${p(mm)}分${p(ss)}秒` : `${mm}分${p(ss)}秒`;
}

/** 秒 -> mm:ss（倒计时用） */
export function fmtCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function notice(kind, text) {
  return h('div', { class: `notice notice-${kind}`, text });
}

export function toast(message, kind = 'info') {
  const el = h('div', {
    class: `notice notice-${kind}`,
    style: 'position:fixed;left:50%;top:20px;transform:translateX(-50%);z-index:99;box-shadow:var(--shadow);max-width:90vw',
    text: message,
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/** 考试数据本地暂存，避免误刷新丢失作答 */
export const draftStore = {
  key: 'exam_draft_v1',
  save(paper) {
    try { localStorage.setItem(this.key, JSON.stringify(paper)); } catch { /* 隐私模式 */ }
  },
  load() {
    try {
      const raw = localStorage.getItem(this.key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  clear() {
    try { localStorage.removeItem(this.key); } catch { /* noop */ }
  },
};
