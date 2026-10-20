// 首页：登录状态、考试规则说明、管理后台入口
import { api, loginUrl } from '../api.js';
import { h, notice } from '../util.js';
import { topbar, rulesCard, errorCard } from '../components.js';
import { closedNotice } from '../config.js';

export async function renderHome({ navigate }) {
  let meta;
  try {
    meta = await api.meta();
  } catch (e) {
    return { element: h('div', { class: 'app' }, [topbar(), errorCard(e, { onRetry: () => navigate('#/') })]), title: '加载失败' };
  }

  const rules = meta.rules;
  const loggedIn = !!meta.user;
  const closed = closedNotice();
  const authError = new URLSearchParams(location.search).get('auth_error');

  const children = [
    topbar(meta),
    h('div', { class: 'card' }, [
      h('h1', { text: '大疆机场 4 认证考试' }),
      closed
        ? h('p', { class: 'muted', text: '本次考试已结束，以下为考试规则留存，供查阅。' })
        : h('p', { class: 'muted', text: '请先阅读考试规则，确认无误后开始答题。考试过程中请勿关闭或刷新页面。' }),
      rulesCard(rules),
      h('h3', { text: '考试说明' }),
      h('ul', { class: 'muted', style: 'margin:0;padding-left:20px' }, [
        h('li', { text: `系统将从 ${meta.bankSize} 道题库中随机抽取 ${rules.questionCount} 道题目，每次抽题均不相同。` }),
        h('li', { text: `每题 ${rules.pointsPerQuestion} 分，满分 ${rules.totalScore} 分，${rules.passScore} 分及以上为合格。` }),
        h('li', { text: `考试时长 ${rules.durationMinutes} 分钟，超时未提交将自动交卷。` }),
        h('li', { text: '答题过程中可随时查看已答题数与剩余题目数，并可在答题卡中跳转检查。' }),
        h('li', { text: `${rules.passScore} 分以下可重新参加考试，多次考试成绩取最高分参与排名。` }),
      ]),
      h('div', { class: 'btn-row mt' }, [
        closed
          ? null
          : loggedIn
            ? h('button', { class: 'btn btn-primary', onClick: () => navigate('#/exam'), text: '开始考试' })
            : h('a', { class: 'btn btn-primary', href: loginUrl() }, ['使用腾讯 OneID 登录答题']),
        h('button', { class: 'btn', onClick: () => navigate('#/ranking'), text: '查看成绩排名' }),
        loggedIn && meta.isAdmin
          ? h('button', { class: 'btn', onClick: () => navigate('#/admin'), text: '进入管理后台' })
          : null,
      ]),
    ]),
  ];

  if (authError) children.splice(1, 0, h('div', { class: 'card' }, [notice('bad', `登录失败：${authError}`)]));
  if (closed) children.splice(1, 0, h('div', { class: 'card' }, [notice('warn', closed)]));
  if (loggedIn) {
    children.splice((authError ? 1 : 0) + (closed ? 1 : 0) + 1, 0, h('div', { class: 'card' }, [
      notice('ok', `已登录：${meta.user.name}${meta.isAdmin ? '（管理后台权限）' : ''}`),
    ]));
  }

  return { element: h('div', { class: 'app' }, children), title: '大疆机场 4 认证考试' };
}
