// 成绩页：分数、是否合格、用时、逐题解析，不合格可重考
import { api } from '../api.js';
import { h, fmtDateTime, fmtDuration, notice } from '../util.js';
import { topbar, errorCard } from '../components.js';

const PAD = (children) => h('div', { class: 'app' }, children);

export async function renderResult({ params, navigate }) {
  let meta;
  try {
    meta = await api.meta();
  } catch (e) {
    return { element: PAD([topbar(), errorCard(e)]), title: '加载失败' };
  }

  if (!meta.user) {
    return {
      element: PAD([topbar(meta), h('div', { class: 'card' }, [notice('warn', '请登录后查看成绩')])]),
      title: '请先登录',
    };
  }

  // 成绩可在交卷后从 sessionStorage 读取（含解析所需题目信息）
  let result = readStored(params.recordId);

  if (!result) {
    // 刷新后本地数据丢失，或管理员从后台点进详情
    try {
      const detail = await api.adminRecord(params.recordId);
      result = fromRecord(detail.record);
    } catch {
      return notFound(meta, navigate);
    }
  }

  const detailMap = new Map((result.details || []).map((d) => [d.id, d]));
  const questions = result.questions || [];
  const pointsPer = result.rules?.pointsPerQuestion ?? 2;
  const passScore = result.passScore ?? result.rules?.passScore ?? 80;
  const passed = result.passed ?? result.score >= passScore;

  const summaryCard = h('div', { class: 'card' }, [
    h('div', { class: 'score-hero' }, [
      h('div', { class: `score-big ${passed ? 'pass' : 'fail'}`, text: String(result.score) }),
      h('div', { class: 'score-sub', text: `满分 ${result.total * pointsPer} 分 · 合格线 ${passScore} 分` }),
    ]),
    h('div', { class: 'center mt' }, [
      notice(passed ? 'ok' : 'bad', passed
        ? `恭喜，考试合格！答对 ${result.correctCount} / ${result.total} 题。`
        : `很遗憾，未达到 ${passScore} 分。答对 ${result.correctCount} / ${result.total} 题，请重新参加考试。`),
    ]),
    h('div', { class: 'rules mt' }, [
      statBox('答题开始', fmtDateTime(result.startedAt)),
      statBox('答题结束', fmtDateTime(result.finishedAt)),
      statBox('答题用时', fmtDuration(result.durationMs)),
      statBox('答对题数', `${result.correctCount} / ${result.total}`),
    ]),
    h('div', { class: 'btn-row mt' }, [
      h('button', {
        class: 'btn btn-primary', text: '再考一次',
        onClick: () => { clearStored(params.recordId); navigate('#/exam'); },
      }),
      h('button', { class: 'btn', text: '查看成绩排名', onClick: () => navigate('#/ranking') }),
      h('button', { class: 'btn', text: '返回首页', onClick: () => navigate('#/') }),
    ]),
  ]);

  const detailCard = h('div', { class: 'card' }, [
    h('h3', { text: '答题详情（正确答案与你的作答）', style: 'margin-top:0' }),
    h('div', { class: 'detail-list' }, questions.map((q, i) => detailItem(q, i, detailMap.get(q.id)))),
  ]);

  return {
    element: PAD([topbar(meta), summaryCard, detailCard]),
    title: `成绩 ${result.score} 分 · 大疆机场 4 认证考试`,
  };
}

function statBox(k, v) {
  return h('div', { class: 'rule' }, [
    h('div', { class: 'k', text: k }),
    h('div', { class: 'v', style: 'font-size:15px', text: v }),
  ]);
}

function detailItem(q, i, d = {}) {
  const originalId = q.originalId != null ? q.originalId : q.id;
  const right = !!d.isCorrect;
  const correctText = d.correctAnswer
    ? `${d.correctAnswer}${d.options?.[d.correctAnswer] ? `（${d.options[d.correctAnswer]}）` : ''}`
    : '—';
  const mineText = d.submittedAnswer
    ? `${d.submittedAnswer}${d.options?.[d.submittedAnswer] ? `（${d.options[d.submittedAnswer]}）` : ''}`
    : '未作答';
  return h('div', { class: `detail-item${right ? '' : ' wrong'}` }, [
    h('div', { class: 'q' }, [
      `${i + 1}. ${q.question}`,
      h('span', { class: `tag ${right ? 'tag-ok' : 'tag-bad'}`, text: right ? '答对' : '答错' }),
    ]),
    h('div', { class: 'detail-line', text: `原题号 #${originalId}` }),
    h('div', { class: 'detail-line', text: `正确答案：${correctText}` }),
    h('div', { class: 'detail-line', text: `你的作答：${mineText}` }),
  ]);
}

function notFound(meta, navigate) {
  return {
    element: PAD([topbar(meta), h('div', { class: 'card' }, [
      h('h2', { text: '找不到成绩记录' }),
      notice('warn', '成绩解析仅在交卷后的当前浏览器会话内可查看，请前往成绩排名查看分数。'),
      h('div', { class: 'btn-row mt' }, [
        h('button', { class: 'btn btn-primary', text: '查看成绩排名', onClick: () => navigate('#/ranking') }),
        h('button', { class: 'btn', text: '返回首页', onClick: () => navigate('#/') }),
      ]),
    ])]),
    title: '找不到成绩',
  };
}

function fromRecord(r) {
  const pointsPer = r.correctCount ? Math.max(1, Math.round(r.score / r.correctCount)) : 2;
  return {
    ...r,
    rules: { passScore: r.passScore, pointsPerQuestion: pointsPer },
    questions: (r.details || []).map((d) => ({ id: d.id, question: d.question, options: d.options })),
  };
}

const storeKey = (id) => `exam_result_${id}`;
function readStored(id) {
  try {
    const raw = sessionStorage.getItem(storeKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function clearStored(id) {
  try { sessionStorage.removeItem(storeKey(id)); } catch { /* noop */ }
}
