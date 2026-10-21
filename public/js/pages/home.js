// 首页：登录状态、考试规则说明、管理后台入口
import { api, loginUrl } from '../api.js';
import { h, notice } from '../util.js';
import { topbar, rulesCard, errorCard } from '../components.js';
import { closedNotice, cachedSite, rankingEnabled } from '../site.js';

export async function renderHome({ navigate }) {
  let meta;
  try {
    meta = await api.meta();
  } catch (e) {
    return { element: h('div', { class: 'app' }, [topbar(), errorCard(e, { onRetry: () => navigate('#/') })]), title: '加载失败' };
  }

  const site = cachedSite() || {};
  const rules = meta.rules;
  const loggedIn = !!meta.user;
  const closed = closedNotice();
  const attemptsLeft = loggedIn ? meta.attemptsLeft : null;
  const outOfAttempts = attemptsLeft === 0;
  const canStart = !closed && !outOfAttempts;
  const authError = new URLSearchParams(location.search).get('auth_error');

  const notes = [
    h('li', { text: `系统将从 ${meta.bankSize} 道题库中随机抽取 ${rules.questionCount} 道单选题，每次抽题均不相同。` }),
    h('li', { text: `每题 ${rules.pointsPerQuestion} 分，满分 ${rules.totalScore} 分，${rules.passScore} 分及以上为合格。` }),
    h('li', { text: `考试时长 ${rules.durationMinutes} 分钟，超时未提交将自动交卷。` }),
    h('li', { text: '每道题只有一个正确答案，答题过程中可随时在答题卡中跳转检查。' }),
    h('li', { text: '交卷后立即出分，成绩以服务端判分结果为准。' }),
  ];
  if (rules.maxAttemptsDesc) notes.push(h('li', { text: `考试次数：${rules.maxAttemptsDesc}。` }));
  if (rules.showRanking) notes.push(h('li', { text: '多次考试成绩取最高分参与排名，同分时用时较短者靠前。' }));

  const startButton = () => {
    if (closed) return null;
    if (!loggedIn) return h('a', { class: 'btn btn-primary', href: loginUrl() }, ['登录并开始答题']);
    if (outOfAttempts) return h('button', { class: 'btn', disabled: true, text: '考试次数已用完' });
    return h('button', { class: 'btn btn-primary', onClick: () => navigate('#/exam'), text: '开始考试' });
  };

  // 登录后把 auth_error 从地址栏清掉，否则刷新还会看到同一条报错
  if (authError) history.replaceState(null, '', location.pathname);

  const children = [
    topbar(meta),
    h('div', { class: 'card' }, [
      h('h1', { text: site.siteName || '考试系统' }),
      closed
        ? h('p', { class: 'muted', text: '本次考试已结束，以下为考试规则留存，供查阅。' })
        : h('p', { class: 'muted', text: '请先阅读考试规则，确认无误后开始答题。考试过程中请勿关闭或刷新页面。' }),
      rulesCard(rules),
      h('h3', { text: '考试说明' }),
      h('ul', { class: 'muted', style: 'margin:0;padding-left:20px' }, notes),
      h('div', { class: 'btn-row mt' }, [
        startButton(),
        rankingEnabled() ? h('button', { class: 'btn', onClick: () => navigate('#/ranking'), text: '查看成绩排名' }) : null,
        loggedIn && meta.isAdmin ? h('button', { class: 'btn', onClick: () => navigate('#/admin'), text: '进入管理后台' }) : null,
      ]),
    ]),
  ];

  const banners = [];
  if (closed) banners.push(h('div', { class: 'card' }, [notice('warn', closed)]));
  if (authError) banners.push(h('div', { class: 'card' }, [notice('bad', `登录失败：${authError}`)]));
  if (loggedIn) {
    const suffix = meta.isAdmin ? '（管理后台权限）' : '';
    const left = attemptsLeft == null ? '' : `，剩余考试次数 ${attemptsLeft} 次`;
    banners.push(h('div', { class: 'card' }, [notice('ok', `已登录：${meta.user.name}${suffix}${left}`)]));
  }
  children.splice(1, 0, ...banners);

  return { element: h('div', { class: 'app' }, children), title: null };
}
