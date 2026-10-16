// 题库加载与随机抽题
import { QUESTION_BANK } from './question-bank.js';

export { QUESTION_BANK };

export function getBankSize() {
  return QUESTION_BANK.length;
}

export function getQuestionById(id) {
  return QUESTION_BANK.find((q) => q.id === id) || null;
}

// Fisher-Yates 洗牌，随机源用 crypto 保证各边缘节点不重复
function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const rand = new Uint32Array(1);
    crypto.getRandomValues(rand);
    const j = rand[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 从题库随机抽 count 道题。
 * 返回的题目包含顺序与选项顺序（选项顺序也打乱，避免背答案位置）。
 */
export function drawQuestions(count) {
  const picked = shuffle(QUESTION_BANK).slice(0, Math.min(count, QUESTION_BANK.length));
  // 统一选项展示顺序，保持与原题库一致（A/B/C/D），题目序号展示原题号
  return picked.map((q) => ({ id: q.id, question: q.question, options: q.options }));
}

/** 按题号取题库原题，用于判分（正确答案只存在服务端） */
export function answerOf(id) {
  const q = getQuestionById(id);
  return q ? q.answer : null;
}
