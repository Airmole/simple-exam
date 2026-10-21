// 成绩页：分数、是否合格、用时、逐题解析，不合格可重考
import { api } from '../api.js';
import { h, fmtDateTime, fmtDuration, notice } from '../util.js';
import { topbar, errorCard } from '../components.js';
import { closedNotice, rankingEnabled, guestAllowed } from '../site.js';

const PAD = (children) => h('div', { class: 'app' }, children);

export async function renderResult({ params, navigate }) {
  let meta;
  try {
    meta = await api.meta();
  } catch (e) {
    return { element: PAD([topbar(), errorCard(e)]), title: '加载失败' };
  }

  // 游客没有账号，成绩只存在当前标签页的 sessionStorage 里，刷新就没了
  const guest = !meta.user && (meta.guest === true || guestAllowed());
  if (!meta.user && !guest) {
    return {
      element: PAD([topbar(meta), h('div', { class: 'card' }, [notice('warn', '请登录后查看成绩')])]),
      title: '请先登录',
    };
  }

  let result = readStored(params.recordId);

  // 游客成绩不在 KV 里，取不到就到此为止，别去后台接口白跑一趟
  if (!result && !guest) {
    // 刷新后本地数据丢失，或管理员从后台点进详情
    try {
      const detail = await api.adminRecord(params.recordId);
      result = fromRecord(detail.record);
    } catch {
      return notFound(meta, navigate, guest);
    }
  }

  const closed = closedNotice();
  const isGuest = result.guest === true;
  const guestNotice = '本次为免登录答题，成绩仅在此页面可见，刷新或关闭后不再保留；如需留存成绩与参与排名，请登录后重考。';
  const detailMap = new Map((result.details || []).map((d) => [d.id, d]));
  const questions = result.questions || [];
  const total = result.total || questions.length || (result.details || []).length;
  const pointsPer = result.rules?.pointsPerQuestion
    ?? (total ? Math.round((result.totalScore || result.score) / total) : null);
  const fullScore = result.totalScore ?? (total && pointsPer ? total * pointsPer : null);
  const passScore = result.passScore ?? result.rules?.passScore ?? null;
  const passed = result.passed ?? (passScore != null && result.score >= passScore);
  const showAnswer = result.showAnswer !== false;

  const summaryCard = h('div', { class: 'card' }, [
    h('div', { class: 'score-hero' }, [
      h('div', { class: `score-big ${passed ? 'pass' : 'fail'}`, text: String(result.score) }),
      h('div', { class: 'score-sub', text: [
        fullScore != null ? `满分 ${fullScore} 分` : null,
        passScore != null ? `合格线 ${passScore} 分` : null,
      ].filter(Boolean).join(' · ') || `共 ${total} 题` }),
    ]),
    h('div', { class: 'center mt' }, [
      notice(passed ? 'ok' : 'bad', passed
        ? `恭喜，考试合格！答对 ${result.correctCount} / ${total} 题。`
        : `很遗憾，未达到 ${passScore} 分。答对 ${result.correctCount} / ${total} 题，请重新参加考试。`),
    ]),
    isGuest ? h('div', { class: 'notice notice-warn mt', text: guestNotice }) : null,
    h('div', { class: 'rules mt' }, [
      statBox('答题开始', fmtDateTime(result.startedAt)),
      statBox('答题结束', fmtDateTime(result.finishedAt)),
      statBox('答题用时', fmtDuration(result.durationMs)),
      statBox('答对题数', `${result.correctCount} / ${total}`),
    ]),
    h('div', { class: 'btn-row mt' }, [
      closed
        ? h('div', { class: 'notice notice-warn', text: closed })
        : h('button', {
          class: 'btn btn-primary', text: '再考一次',
          onClick: () => { clearStored(params.recordId); navigate('#/exam'); },
        }),
      // 游客成绩不进排名，这里仅作为浏览入口
      rankingEnabled() && !isGuest ? h('button', { class: 'btn', text: '查看成绩排名', onClick: () => navigate('#/ranking') }) : null,
      h('button', { class: 'btn', text: '返回首页', onClick: () => navigate('#/') }),
    ]),
  ]);

  // 逐题解析的内容在交卷那一刻才完整；刷新后若记录被裁剪，就只能看分数
  const detailItems = questions.map((q, i) => detailItem(q, i, detailMap.get(q.id), { showAnswer }));
  const detailCard = h('div', { class: 'card' }, [
    h('h3', { text: showAnswer ? '答题详情（正确答案与你的作答）' : '答题详情（你的作答）', style: 'margin-top:0' }),
    showAnswer ? null : h('div', { class: 'muted', style: 'margin-bottom:8px', text: '本次考试不公开正确答案，仅展示你的作答。' }),
    h('div', { class: 'detail-list' }, detailItems),
  ]);

  return {
    element: PAD([topbar(meta), summaryCard, detailItems.length ? detailCard : null].filter(Boolean)),
    title: `成绩 ${result.score} 分`,
  };
}

function statBox(k, v) {
  return h('div', { class: 'rule' }, [
    h('div', { class: 'k', text: k }),
    h('div', { class: 'v', style: 'font-size:15px', text: v }),
  ]);
}

function detailItem(q, i, d = {}, { showAnswer = true } = {}) {
  const originalId = q.originalId != null ? q.originalId : q.id;
  const judged = showAnswer && typeof d.isCorrect === 'boolean';
  const right = judged && d.isCorrect;
  const optionText = (key, options) => (key
    ? `${key}${(options || q.options)?.[key] ? `（${(options || q.options)[key]}）` : ''}`
    : null);
  const mineText = optionText(d.submittedAnswer, d.options) || '未作答';
  return h('div', { class: `detail-item${judged && !right ? ' wrong' : ''}` }, [
    h('div', { class: 'q' }, [
      `${i + 1}. ${q.question}`,
      judged ? h('span', { class: `tag ${right ? 'tag-ok' : 'tag-bad'}`, text: right ? '答对' : '答错' }) : null,
    ]),
    h('div', { class: 'detail-line', text: `题库 #${originalId}` }),
    showAnswer ? h('div', { class: 'detail-line', text: `正确答案：${optionText(d.correctAnswer, d.options) || '—'}` }) : null,
    h('div', { class: 'detail-line', text: `你的作答：${mineText}` }),
  ]);
}

function notFound(meta, navigate, guest) {
  return {
    element: PAD([topbar(meta), h('div', { class: 'card' }, [
      h('h2', { text: '找不到成绩记录' }),
      notice('warn', guest
        ? '免登录答题的成绩不会保存，仅在交卷后立即展示一次，刷新后即不可再查看。'
        : '成绩解析仅在交卷后的当前浏览器会话内可查看。'),
      h('div', { class: 'btn-row mt' }, [
        rankingEnabled() ? h('button', { class: 'btn btn-primary', text: '查看成绩排名', onClick: () => navigate('#/ranking') }) : null,
        h('button', { class: 'btn', text: '返回首页', onClick: () => navigate('#/') }),
      ].filter(Boolean)),
    ])]),
    title: '找不到成绩',
  };
}

// 从管理端记录还原成绩页：正确答案是否可见取决于记录里是否还有 correctAnswer
function fromRecord(r) {
  return {
    ...r,
    totalScore: r.total && r.correctCount != null && r.score
      ? r.total * Math.round(r.score / Math.max(1, r.correctCount))
      : null,
    showAnswer: (r.details || []).some((d) => d.correctAnswer),
    questions: (r.details || []).map((d) => ({ id: d.id, question: d.question, options: d.options })),
  };
}

// 'latest' 用于未留存记录（EXAM_KEEP_RECORDS=false）时的成绩页
const storeKey = (id) => (id === 'latest' ? 'exam_result_latest' : `exam_result_${id}`);
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
