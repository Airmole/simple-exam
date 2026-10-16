// 应用入口：极简 hash 路由 + 页面渲染
import { $, h } from './util.js';
import { renderHome } from './pages/home.js';
import { renderExam } from './pages/exam.js';
import { renderResult } from './pages/result.js';
import { renderRanking } from './pages/ranking.js';
import { renderAdmin } from './pages/admin.js';

const app = $('#app');

const routes = [
  { pattern: /^#?\/?$/, view: renderHome, title: '大疆机场 4 认证考试' },
  { pattern: /^#\/exam$/, view: renderExam, title: '正在考试 · 大疆机场 4 认证考试' },
  { pattern: /^#\/result\/(.+)$/, view: renderResult, title: '考试成绩 · 大疆机场 4 认证考试', params: (m) => ({ recordId: decodeURIComponent(m[1]) }) },
  { pattern: /^#\/ranking$/, view: renderRanking, title: '成绩排名 · 大疆机场 4 认证考试' },
  { pattern: /^#\/admin$/, view: renderAdmin, title: '管理后台 · 大疆机场 4 认证考试' },
];

let viewState = null;

export function navigate(hash) {
  if (location.hash === hash) return render();
  location.hash = hash;
}

function parse() {
  const hash = location.hash || '#/';
  for (const r of routes) {
    const m = hash.match(r.pattern);
    if (m) return { route: r, params: r.params ? r.params(m) : {} };
  }
  return { route: routes[0], params: {} };
}

// 考试进行中离开页面时提示，避免误刷新丢失作答
export function setLeaveGuard(active) {
  window.onbeforeunload = active ? (e) => { e.preventDefault(); e.returnValue = ''; } : null;
}

async function render() {
  const { route, params } = parse();
  if (viewState && typeof viewState.destroy === 'function') viewState.destroy();
  viewState = null;
  setLeaveGuard(false);
  app.innerHTML = '<div class="loading">加载中…</div>';

  try {
    const result = await route.view({ params, navigate, setLeaveGuard });
    viewState = result;
    app.innerHTML = '';
    app.appendChild(result.element);
    document.title = result.title || route.title;
    window.scrollTo(0, 0);
  } catch (e) {
    app.innerHTML = '';
    app.appendChild(h('div', { class: 'card' }, [
      h('h2', { text: '页面加载失败' }),
      h('div', { class: 'notice notice-bad', text: e.message || '未知错误' }),
      h('div', { class: 'mt' }, [h('a', { class: 'btn', href: '#/', text: '返回首页' })]),
    ]));
  }
}

window.addEventListener('hashchange', render);

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', render);
} else {
  render();
}

export { render };
