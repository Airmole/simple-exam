// 管理后台：统计指标 + 答题记录列表 + 记录详情
import { api } from '../api.js';
import { h, fmtDateTime, fmtDuration, notice } from '../util.js';
import { topbar, errorCard } from '../components.js';

export async function renderAdmin({ navigate }) {
  let meta;
  try {
    meta = await api.meta();
  } catch (e) {
    return { element: wrap([topbar(), errorCard(e)]), title: '加载失败' };
  }

  if (!meta.user) {
    return {
      element: wrap([topbar(meta), h('div', { class: 'card' }, [
        h('h2', { text: '需要登录' }),
        notice('warn', '管理后台仅限指定用户访问。'),
        h('div', { class: 'btn-row mt' }, [h('a', { class: 'btn btn-primary', href: '/api/auth/login', text: '使用 OneID 登录' })]),
      ])]),
      title: '请先登录',
    };
  }

  if (!meta.isAdmin) return noPermission(meta);

  let statsRes;
  let recordsRes;
  try {
    [statsRes, recordsRes] = await Promise.all([api.adminStats(), api.adminRecords()]);
  } catch (e) {
    if (e.status === 403) return noPermission(meta);
    return { element: wrap([topbar(meta), errorCard(e, { onRetry: () => navigate('#/admin') })]), title: '加载失败' };
  }

  const s = statsRes.stats;
  const extra = statsRes.extra || {};
  const records = recordsRes.records || [];

  const statsGrid = h('div', { class: 'stat-grid' }, [
    statCard('考试人数', s.uniqueUsers, '人'),
    statCard('考试次数', s.attempts, '次'),
    statCard('合格率', s.passRate, '%'),
    statCard('平均分', s.avgScore, '分'),
    statCard('最高分', s.maxScore ?? '—', '分'),
    statCard('最低分', s.minScore ?? '—', '分'),
    statCard('最快答题', extra.fastest ? fmtDuration(extra.fastest.durationMs) : '—', extra.fastest ? extra.fastest.name : ''),
    statCard('最慢答题', extra.slowest ? fmtDuration(extra.slowest.durationMs) : '—', extra.slowest ? extra.slowest.name : ''),
  ]);

  const listBody = records.length
    ? h('tbody', {}, records.map((r) => h('tr', {}, [
        h('td', { text: r.name || '—' }),
        h('td', { class: 'num' }, [h('b', { text: String(r.score) })]),
        h('td', {}, [h('span', { class: `tag ${r.passed ? 'tag-ok' : 'tag-bad'}`, text: r.passed ? '合格' : '不合格' })]),
        h('td', { class: 'num', text: `${r.correctCount}/${r.total}` }),
        h('td', { class: 'num', text: fmtDuration(r.durationMs) }),
        h('td', { class: 'num', text: fmtDateTime(r.startedAt) }),
        h('td', { class: 'num', text: fmtDateTime(r.finishedAt) }),
        h('td', {}, [h('button', { class: 'btn btn-ghost', text: '查看详情', onClick: () => showDetail(r) })]),
      ])))
    : h('tbody', {}, [h('tr', {}, [h('td', { colspan: '8', class: 'center muted', text: '暂无答题记录' })])]);

  const children = [
    topbar(meta),
    h('div', { class: 'card' }, [
      h('h1', { text: '管理后台' }),
      h('p', { class: 'muted', text: '数据统计与答题记录浏览。' }),
      statsGrid,
    ]),
    h('div', { class: 'card' }, [
      h('h3', { text: '答题记录', style: 'margin-top:0' }),
      h('div', { class: 'table-wrap' }, [
        h('table', {}, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: '姓名' }),
            h('th', { text: '分数' }),
            h('th', { text: '结果' }),
            h('th', { text: '答对' }),
            h('th', { text: '用时' }),
            h('th', { text: '开始时间' }),
            h('th', { text: '结束时间' }),
            h('th', { text: '' }),
          ])]),
          listBody,
        ]),
      ]),
      h('div', { class: 'btn-row mt' }, [
        h('button', { class: 'btn', text: '刷新数据', onClick: () => navigate('#/admin') }),
        h('button', { class: 'btn', text: '返回首页', onClick: () => navigate('#/') }),
      ]),
    ]),
  ];

  return { element: wrap(children), title: '管理后台 · 大疆机场 4 认证考试' };
}

function statCard(k, v, unit) {
  return h('div', { class: 'stat' }, [
    h('div', { class: 'k', text: k }),
    h('div', { class: 'v' }, [String(v), unit ? h('small', { text: ` ${unit}` }) : null]),
  ]);
}

function noPermission(meta) {
  return {
    element: wrap([topbar(meta), h('div', { class: 'card' }, [
      h('h2', { text: '无权访问' }),
      notice('bad', '你没有管理后台的访问权限。如需开通，请联系管理员将你的 OneID 账号加入白名单。'),
      h('div', { class: 'btn-row mt' }, [
        h('button', { class: 'btn btn-primary', text: '返回首页', onClick: () => { location.hash = '#/'; } }),
        h('button', { class: 'btn', text: '查看成绩排名', onClick: () => { location.hash = '#/ranking'; } }),
      ]),
    ])]),
    title: '无权访问',
  };
}

function wrap(children) {
  return h('div', { class: 'app' }, children);
}

// 记录详情：弹出遮罩层展示逐题作答（含正确答案与用户答案）
async function showDetail(row) {
  const overlay = h('div', {
    class: 'overlay',
    style: 'position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:50;overflow:auto;padding:20px',
  });
  const panel = h('div', { class: 'card', style: 'max-width:820px;margin:0 auto' }, [
    h('div', { class: 'loading', text: '加载详情…' }),
  ]);
  overlay.appendChild(panel);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  try {
    const res = await api.adminRecord(row.id);
    const r = res.record;
    panel.innerHTML = '';
    panel.appendChild(h('div', { class: 'question-head' }, [
      h('h2', { text: `${r.name} 的答题记录`, style: 'margin:0' }),
      h('button', { class: 'btn', text: '关闭', onClick: () => overlay.remove() }),
    ]));
    panel.appendChild(h('div', { class: 'rules mt' }, [
      miniStat('分数', `${r.score} 分`),
      miniStat('结果', r.passed ? '合格' : '不合格'),
      miniStat('答对', `${r.correctCount} / ${r.total}`),
      miniStat('开始', fmtDateTime(r.startedAt)),
      miniStat('结束', fmtDateTime(r.finishedAt)),
      miniStat('用时', fmtDuration(r.durationMs)),
    ]));
    panel.appendChild(h('h3', { text: '逐题作答明细' }));
    panel.appendChild(h('div', { class: 'detail-list' }, (r.details || []).map((d, i) => h('div', {
      class: `detail-item${d.isCorrect ? '' : ' wrong'}`,
    }, [
      h('div', { class: 'q' }, [
        `${i + 1}. ${d.question}`,
        h('span', { class: `tag ${d.isCorrect ? 'tag-ok' : 'tag-bad'}`, text: d.isCorrect ? '对' : '错' }),
      ]),
      h('div', { class: 'detail-line', text: `原题号 #${d.id}` }),
      h('div', { class: 'detail-line', text: `正确答案：${d.correctAnswer ?? '—'}${d.correctAnswer && d.options?.[d.correctAnswer] ? `（${d.options[d.correctAnswer]}）` : ''}` }),
      h('div', { class: 'detail-line', text: `用户作答：${d.submittedAnswer ?? '未作答'}${d.submittedAnswer && d.options?.[d.submittedAnswer] ? `（${d.options[d.submittedAnswer]}）` : ''}` }),
    ]))));
  } catch (e) {
    panel.innerHTML = '';
    panel.appendChild(notice('bad', `加载详情失败：${e.message}`));
    panel.appendChild(h('div', { class: 'btn-row mt' }, [h('button', { class: 'btn', text: '关闭', onClick: () => overlay.remove() })]));
  }
}

function miniStat(k, v) {
  return h('div', { class: 'rule' }, [
    h('div', { class: 'k', text: k }),
    h('div', { class: 'v', style: 'font-size:14px', text: v }),
  ]);
}
