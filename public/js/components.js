// 共用 UI 片段
import { h } from './util.js';
import { cachedSite, rankingEnabled } from './site.js';

export function topbar(meta = {}) {
  const site = cachedSite() || {};
  const user = meta.user;
  const actions = [];
  if (rankingEnabled()) actions.push(h('a', { href: '#/ranking', text: '成绩排名' }));
  if (user && meta.isAdmin) actions.push(h('a', { href: '#/admin', text: '管理后台' }));
  if (user) {
    actions.push(h('span', { class: 'muted' }, [user.name]));
    actions.push(h('a', { href: '/api/auth/logout', text: '退出登录' }));
  } else if (!site.allowGuest) {
    // 免登录答题时不显示「登录」，免得把人引到走不通的 OneID 上
    actions.push(h('a', { href: '/api/auth/login', text: '登录' }));
  }
  return h('div', { class: 'topbar' }, [
    h('a', { class: 'brand', href: '#/' }, [
      h('span', { class: 'logo', text: site.logo || 'Q' }),
      h('span', { text: site.siteName || '考试系统' }),
    ]),
    h('div', { class: 'topbar-actions' }, actions),
  ]);
}

export function rulesCard(rules) {
  const items = [
    ['题目数量', rules.questionCount, '题'],
    ['每题分值', rules.pointsPerQuestion, '分'],
    ['试卷满分', rules.totalScore, '分'],
    ['合格分数', rules.passScore, '分'],
    ['考试时长', rules.durationMinutes, '分钟'],
  ];
  if (rules.maxAttemptsDesc) items.push(['考试次数', rules.maxAttemptsDesc, '']);
  return h('div', { class: 'rules' }, items.map(([k, v, unit]) => rule(k, v, unit)));
}

function rule(k, v, unit) {
  return h('div', { class: 'rule' }, [
    h('div', { class: 'k', text: k }),
    h('div', { class: 'v' }, [String(v), unit ? h('small', { text: ` ${unit}` }) : null]),
  ]);
}

export function errorCard(error, { onRetry, retryText = '重试' } = {}) {
  const children = [
    h('h2', { text: '出错了' }),
    h('div', { class: 'notice notice-bad', text: error.message || String(error) }),
  ];
  const actions = [];
  if (onRetry) actions.push(h('button', { class: 'btn btn-primary', onClick: onRetry, text: retryText }));
  if (error.status === 401) actions.push(h('a', { class: 'btn', href: '/api/auth/login', text: '去登录' }));
  if (actions.length) children.push(h('div', { class: 'btn-row mt' }, actions));
  return h('div', { class: 'card' }, children);
}
