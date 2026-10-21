// 站点配置：品牌名、Logo、主题色、截止时间全部来自服务端环境变量（/api/site），
// 前端只做缓存与 DOM 应用，改配置不用重新构建静态资源。

const SITE_KEY = 'site_config_v1';
const THEME_KEY = 'site_theme_v1';
const DEFAULT_NAME = '考试系统';

const html = document.documentElement;

function hexToRgb(hex) {
  const m = String(hex || '').replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function shade(rgb, ratio) {
  const target = ratio < 0 ? 0 : 255;
  const amount = Math.abs(ratio);
  return `rgb(${rgb.map((v) => Math.round(v + (target - v) * amount)).join(', ')})`;
}

/** 把主题色写进 CSS 变量，并顺带算一个更深的 --brand-dark */
function applyTheme(color) {
  const rgb = hexToRgb(color);
  if (!rgb) return false;
  html.style.setProperty('--brand', color);
  html.style.setProperty('--brand-dark', shade(rgb, -0.22));
  try { localStorage.setItem(THEME_KEY, color); } catch { /* 隐私模式 */ }
  return true;
}

let current = null;

function remember(site) {
  current = site;
  try { localStorage.setItem(SITE_KEY, JSON.stringify(site)); } catch { /* 隐私模式 */ }
  applyTheme(site.brandColor);
  return site;
}

/** 上次访问缓存的配置，用于首屏先渲染品牌，避免闪一下默认标题 */
export function cachedSite() {
  if (current) return current;
  try {
    const raw = localStorage.getItem(SITE_KEY);
    return raw ? remember(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** 拉取站点配置（不依赖登录态）；失败时退回缓存或内置默认值 */
export async function loadSite() {
  try {
    const res = await fetch('/api/site', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(String(res.status));
    return remember(await res.json());
  } catch {
    return cachedSite() || remember({ siteName: DEFAULT_NAME, logo: 'Q', brandColor: '#0f5fff' });
  }
}

/** 页面标题统一带上站点名 */
export function titleOf(page) {
  const name = (current && current.siteName) || DEFAULT_NAME;
  return page ? `${page} · ${name}` : name;
}

/** 是否已过考试截止时间 */
export function examClosed() {
  const site = cachedSite();
  return !!site && site.deadlineAt != null && Date.now() >= site.deadlineAt;
}

/** 截止时间文案，如 2026-12-31 23:59 */
export function deadlineText() {
  const site = cachedSite();
  return (site && site.deadline) || '';
}

/** 未截止返回 null，已截止返回统一提示文案 */
export function closedNotice() {
  if (!examClosed()) return null;
  return `本次考试已于 ${deadlineText()} 截止，不再开放新的考试，感谢参与。`;
}

/** 是否展示成绩排名 */
export function rankingEnabled() {
  const site = cachedSite();
  return !site || site.showRanking !== false;
}

// 首屏先套用缓存里的主题色，避免等接口期间闪回默认色
try {
  const boot = localStorage.getItem(THEME_KEY);
  if (boot) applyTheme(boot);
} catch { /* noop */ }
