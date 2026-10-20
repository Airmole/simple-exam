// 答题页：实时展示用时/剩余时长/已答数/剩余数/原题号，支持答题卡跳转与自动交卷
import { api } from '../api.js';
import { h, fmtCountdown, fmtTime, toast, draftStore, notice } from '../util.js';
import { topbar, errorCard } from '../components.js';
import { closedNotice } from '../config.js';

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

export async function renderExam({ navigate, setLeaveGuard }) {
  let meta;
  try {
    meta = await api.meta();
  } catch (e) {
    return { element: h('div', { class: 'app' }, [topbar(), errorCard(e)]), title: '加载失败' };
  }

  // 考试结束后不再抽取新试卷，直接拦在答题页外面
  const closed = closedNotice();
  const draft = draftStore.load();
  const hasDraft = !!closed && draft && draft.sub === meta.user?.sub && draft.expiresAt > Date.now();
  if (closed && !hasDraft) {
    return {
      element: h('div', { class: 'app' }, [
        topbar(meta),
        h('div', { class: 'card' }, [
          h('h2', { text: '考试已截止' }),
          notice('warn', closed),
          h('div', { class: 'btn-row mt' }, [
            h('button', { class: 'btn btn-primary', text: '查看成绩排名', onClick: () => navigate('#/ranking') }),
            h('button', { class: 'btn', text: '返回首页', onClick: () => navigate('#/') }),
          ]),
        ]),
      ]),
      title: '考试已截止',
    };
  }

  if (!meta.user) {
    return {
      element: h('div', { class: 'app' }, [
        topbar(meta),
        h('div', { class: 'card' }, [
          h('h2', { text: '请先登录' }),
          notice('warn', '考试需要登录后参加。'),
          h('div', { class: 'btn-row mt' }, [h('a', { class: 'btn btn-primary', href: '/api/auth/login', text: '使用 OneID 登录' })]),
        ]),
      ]),
      title: '请先登录',
    };
  }

  // 恢复本用户未超时的草稿，否则重新抽题
  let paper = draftStore.load();
  if (paper && paper.sub !== meta.user.sub) paper = null;   // 换人登录，丢弃上一位用户的草稿
  if (paper && paper.expiresAt && Date.now() > paper.expiresAt) {
    toast('上次考试已超时，已重新抽题', 'warn');
    paper = null;
  }

  if (!paper) {
    draftStore.clear();
    try {
      const started = await api.startExam();
      paper = {
        sub: meta.user.sub,
        questions: started.questions,
        answers: {},
        startedAt: started.startedAt,
        expiresAt: started.expiresAt,
        durationSeconds: started.durationSeconds,
        rules: started.rules,
      };
      draftStore.save(paper);
    } catch (e) {
      return { element: h('div', { class: 'app' }, [topbar(meta), errorCard(e)]), title: '无法开始考试' };
    }
  }

  const state = {
    index: 0,
    submitted: false,
    timerId: null,
    tickId: null,
    destroyed: false,
  };

  const answeredCount = () => Object.values(paper.answers).filter((v) => v != null).length;

  /* ---- 顶部状态栏 ---- */
  const statusEl = h('div', { class: 'exam-status' });
  const statusGrid = h('div', { class: 'status-grid' });
  let progressBar;
  statusEl.appendChild(statusGrid);
  statusEl.appendChild(progressBar = h('div', { class: 'progress' }, [h('i', { style: 'width:0%' })]));

  /* ---- 题目区 ---- */
  const questionCard = h('div', { class: 'card' });

  /* ---- 答题卡 ---- */
  const answerGrid = h('div', { class: 'answer-grid' });
  const sheetCard = h('div', { class: 'card' }, [
    h('h3', { text: '答题卡', style: 'margin-top:0' }),
    h('div', { class: 'muted', id: 'sheet-hint' }),
    answerGrid,
  ]);

  function renderStatus() {
    const now = Date.now();
    const elapsed = now - paper.startedAt;
    const remain = Math.max(0, Math.floor((paper.expiresAt - now) / 1000));
    const answered = answeredCount();
    const total = paper.questions.length;

    statusGrid.innerHTML = '';
    const items = [
      ['开始时间', fmtTime(paper.startedAt)],
      ['已用时长', fmtDurationShort(elapsed)],
      ['剩余时长', fmtCountdown(remain), remain <= 60],
      ['已答题数', `${answered} / ${total}`],
      ['剩余题目', String(total - answered)],
      ['当前题号', `第 ${state.index + 1} 题`],
    ];
    items.forEach(([label, value, urgent]) => {
      statusGrid.appendChild(h('div', { class: 'item' }, [
        h('span', { class: 'label', text: label }),
        h('span', { class: `value${urgent ? ' urgent' : ''}`, text: value }),
      ]));
    });
    progressBar.firstChild.style.width = `${total ? (answered / total) * 100 : 0}%`;
  }

  function fmtDurationShort(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    const hh = Math.floor(mm / 60);
    const p = (n) => String(n).padStart(2, '0');
    return hh > 0 ? `${hh}:${p(mm % 60)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
  }

  /* ---- 单题渲染 ---- */
  function renderQuestion() {
    const q = paper.questions[state.index];
    const total = paper.questions.length;
    const selected = paper.answers[q.id];
    const originalId = q.originalId != null ? q.originalId : q.id;

    questionCard.innerHTML = '';
    questionCard.appendChild(h('div', { class: 'question-head' }, [
      h('span', { class: 'question-no' }, [
        `第 ${state.index + 1} / ${total} 题`,
        ' · ',
        h('b', { text: `原题号 #${originalId}` }),
      ]),
      h('span', { class: 'muted', style: 'font-size:13px', text: `${paper.rules.pointsPerQuestion} 分` }),
    ]));
    questionCard.appendChild(h('div', { class: 'q-title', text: q.question }));

    const options = h('div', { class: 'options' });
    OPTION_KEYS.filter((k) => q.options[k] != null).forEach((key) => {
      const isSel = selected === key;
      const label = h('label', { class: `option${isSel ? ' selected' : ''}` }, [
        h('input', {
          type: 'radio', name: `q_${q.id}`, value: key, checked: isSel,
          onChange: () => { paper.answers[q.id] = key; draftStore.save(paper); renderQuestion(); renderSheet(); renderStatus(); },
        }),
        h('span', { class: 'key', text: key }),
        h('span', { class: 'txt', text: q.options[key] }),
      ]);
      options.appendChild(label);
    });
    questionCard.appendChild(options);

    questionCard.appendChild(h('div', { class: 'nav-row' }, [
      h('button', {
        class: 'btn', disabled: state.index === 0, text: '上一题',
        onClick: () => { state.index--; renderQuestion(); renderSheet(); renderStatus(); },
      }),
      h('div', { class: 'btn-row' }, [
        selected ? h('button', {
          class: 'btn btn-ghost', text: '清除选择',
          onClick: () => { delete paper.answers[q.id]; draftStore.save(paper); renderQuestion(); renderSheet(); renderStatus(); },
        }) : null,
        state.index < total - 1
          ? h('button', { class: 'btn btn-primary', text: '下一题', onClick: () => { state.index++; renderQuestion(); renderSheet(); renderStatus(); } })
          : h('button', { class: 'btn btn-primary', text: '检查并交卷', onClick: confirmSubmit }),
      ]),
    ]));
  }

  /* ---- 答题卡 ---- */
  function renderSheet() {
    answerGrid.innerHTML = '';
    paper.questions.forEach((q, i) => {
      const done = paper.answers[q.id] != null;
      answerGrid.appendChild(h('button', {
        class: `${done ? 'done ' : ''}${i === state.index ? 'current' : ''}`,
        text: String(i + 1),
        title: `原题号 #${q.originalId ?? q.id}`,
        onClick: () => { state.index = i; renderQuestion(); renderSheet(); renderStatus(); },
      }));
    });
    const hint = sheetCard.querySelector('#sheet-hint');
    if (hint) hint.textContent = `已答 ${answeredCount()} 题，未答 ${paper.questions.length - answeredCount()} 题，点击题号可跳转。`;
  }

  /* ---- 交卷 ---- */
  function confirmSubmit() {
    const unanswered = paper.questions.length - answeredCount();
    const msg = unanswered > 0
      ? `还有 ${unanswered} 题未作答，确定要交卷吗？未作答的题目将不得分。`
      : '确认提交试卷吗？提交后无法修改。';
    if (window.confirm(msg)) submit();
  }

  async function submit(auto = false) {
    if (state.submitted) return;
    state.submitted = true;
    stopTimers();
    setLeaveGuard(false);

    const payload = {
      answers: paper.answers,
      startedAt: paper.startedAt,
      questionIds: paper.questions.map((q) => q.id),
    };
    questionCard.innerHTML = '';
    questionCard.appendChild(h('div', { class: 'center muted', text: auto ? '考试时间结束，正在自动交卷…' : '正在提交试卷…' }));

    try {
      const res = await api.submitExam(payload);
      draftStore.clear();
      sessionStorage.setItem(`exam_result_${res.recordId}`, JSON.stringify({
        ...res,
        questions: paper.questions,
        rules: paper.rules,
      }));
      navigate(`#/result/${encodeURIComponent(res.recordId)}`);
    } catch (e) {
      state.submitted = false;
      questionCard.innerHTML = '';
      questionCard.appendChild(notice('bad', `交卷失败：${e.message}`));
      questionCard.appendChild(h('div', { class: 'btn-row mt' }, [
        h('button', { class: 'btn btn-primary', text: '重新提交', onClick: () => submit(auto) }),
        h('button', { class: 'btn', text: '返回继续答题', onClick: () => { renderQuestion(); renderSheet(); startTimers(); } }),
      ]));
    }
  }

  /* ---- 计时 ---- */
  function startTimers() {
    stopTimers();
    renderStatus();
    state.tickId = setInterval(() => {
      if (state.destroyed) return;
      renderStatus();
      if (Date.now() >= paper.expiresAt) {
        toast('考试时间已到，正在自动交卷', 'warn');
        submit(true);
      }
    }, 1000);
  }

  function stopTimers() {
    if (state.tickId) clearInterval(state.tickId);
    if (state.timerId) clearTimeout(state.timerId);
    state.tickId = null;
    state.timerId = null;
  }

  renderQuestion();
  renderSheet();
  startTimers();
  setLeaveGuard(true);

  const element = h('div', { class: 'app' }, [
    topbar(meta),
    statusEl,
    h('div', { class: 'btn-row', style: 'margin-bottom:12px' }, [
      h('button', { class: 'btn btn-primary', text: '提交试卷', onClick: confirmSubmit }),
      h('span', { class: 'muted', style: 'align-self:center;font-size:13px', text: '作答会自动保存在本地，刷新页面可恢复进度' }),
    ]),
    questionCard,
    sheetCard,
  ]);

  return {
    element,
    title: '正在考试 · 大疆机场 4 认证考试',
    destroy: () => { state.destroyed = true; stopTimers(); },
  };
}
