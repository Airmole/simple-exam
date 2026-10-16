// 排名页：同一用户取最高分，同分用时短者靠前
import { api } from '../api.js';
import { h, fmtDuration, fmtDateTime } from '../util.js';
import { topbar, errorCard } from '../components.js';

export async function renderRanking({ navigate }) {
  let meta;
  let ranking;
  try {
    meta = await api.meta();
    const res = await api.ranking();
    ranking = res.ranking;
  } catch (e) {
    return { element: h('div', { class: 'app' }, [topbar(), errorCard(e, { onRetry: () => navigate('#/ranking') })]), title: '加载失败' };
  }

  const mySub = meta.user ? meta.user.sub : null;
  const myRow = mySub ? ranking.find((r) => r.sub === mySub) : null;

  const rows = ranking.map((r) => h('tr', { class: r.sub === mySub ? 'me' : '' }, [
    h('td', { class: `num ${rankClass(r.rank)}`, text: String(r.rank) }),
    h('td', {}, [
      r.name,
      r.sub === mySub ? h('span', { class: 'tag tag-ok', text: '我' }) : null,
    ]),
    h('td', { class: 'num' }, [h('b', { text: String(r.score) })]),
    h('td', { class: 'num', text: fmtDuration(r.durationMs) }),
    h('td', { class: 'num', text: fmtDateTime(r.finishedAt) }),
  ]));

  const table = ranking.length
    ? h('div', { class: 'table-wrap' }, [
        h('table', {}, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: '排名' }),
            h('th', { text: '姓名' }),
            h('th', { text: '最高分' }),
            h('th', { text: '答题用时' }),
            h('th', { text: '完成时间' }),
          ])]),
          h('tbody', {}, rows),
        ]),
      ])
    : h('div', { class: 'muted center', style: 'padding:24px 0', text: '暂无成绩记录，快来成为第一个吧。' });

  const children = [
    topbar(meta),
    h('div', { class: 'card' }, [
      h('h1', { text: '成绩排名' }),
      h('p', { class: 'muted', text: '同一用户多次考试取最高分参与排名，成绩相同时答题用时较短者靠前。' }),
      myRow
        ? h('div', { class: 'notice notice-info', text: `你的最好成绩：${myRow.score} 分，用时 ${fmtDuration(myRow.durationMs)}，当前排名第 ${myRow.rank} 名。` })
        : null,
      h('div', { class: 'mt' }, [table]),
      h('div', { class: 'btn-row mt' }, [
        h('button', { class: 'btn btn-primary', text: '去考试', onClick: () => navigate('#/exam') }),
        h('button', { class: 'btn', text: '返回首页', onClick: () => navigate('#/') }),
        h('button', { class: 'btn', text: '刷新', onClick: () => navigate('#/ranking') }),
      ]),
    ]),
  ];

  return { element: h('div', { class: 'app' }, children), title: '成绩排名 · 大疆机场 4 认证考试' };
}

function rankClass(rank) {
  if (rank === 1) return 'rank-1';
  if (rank === 2) return 'rank-2';
  if (rank === 3) return 'rank-3';
  return '';
}
