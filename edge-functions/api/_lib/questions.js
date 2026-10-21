// 题库加载与随机抽题
//
// 题库在构建时由 EdgeOne 打包进函数，支持两种放置方式（按顺序探测）：
//   1. data/questions.json        —— 仓库 data/ 目录下的题库文件
//   2. _lib/question-bank.js      —— 上面的 JSON 转成的 JS 模块（兼容无法导入 JSON 的运行时）
// 每题形如 { id, question, options: { A, B, C, D }, answer: "C" }，选项至少 2 个。
//
// 模块级缓存：同一边缘节点上只解析、校验一次。

import { QUESTION_BANK as JSON_MODULE_BANK } from './question-bank.js';

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const FILE_CANDIDATES = ['../../data/questions.json', '../../data/questions.example.json'];

let cachedBank = null;
let loading = null;

function normalize(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.questions) ? raw.questions : null;
  if (!list) throw new Error('题库格式错误：应为数组，或带 questions 数组的对象');

  const bank = [];
  const usedIds = new Set();
  list.forEach((item, i) => {
    const where = `第 ${i + 1} 题`;
    const text = String(item?.question ?? '').trim();
    if (!text) throw new Error(`${where} 缺少 question 字段`);

    const options = item?.options;
    const keys = options && typeof options === 'object'
      ? Object.keys(options).filter((k) => options[k] != null && String(options[k]).trim() !== '')
      : [];
    // 保持 A/B/C… 顺序，题库里选项乱序也照字母排
    const sorted = keys.sort((a, b) => OPTION_KEYS.indexOf(a.toUpperCase()) - OPTION_KEYS.indexOf(b.toUpperCase()));
    if (sorted.length < 2) throw new Error(`${where} 至少需要 2 个选项`);

    const answer = String(item?.answer ?? '').trim().toUpperCase();
    if (!sorted.some((k) => k.toUpperCase() === answer)) {
      throw new Error(`${where} 的 answer（${answer || '空'}）不在选项 ${sorted.join('/')} 里`);
    }

    // id 缺省时按顺序补，重复的直接报错——题号是判分与解析的锚点
    const id = Number.isInteger(item?.id) ? item.id : i + 1;
    if (usedIds.has(id)) throw new Error(`${where} 的 id（${id}）与前面的题目重复`);
    usedIds.add(id);

    const normalizedOptions = {};
    sorted.forEach((k) => { normalizedOptions[k.toUpperCase()] = String(options[k]).trim(); });
    bank.push({ id, question: text, options: normalizedOptions, answer });
  });

  if (!bank.length) throw new Error('题库为空');
  return bank;
}

/** 依次尝试各来源，返回原始题库对象 */
async function loadRaw() {
  const errors = [];
  for (const file of FILE_CANDIDATES) {
    try {
      const mod = await import(new URL(file, import.meta.url).href, { with: { type: 'json' } });
      if (mod?.default) return mod.default;
    } catch (e) {
      errors.push(`${file}: ${e.message}`);
    }
  }
  if (JSON_MODULE_BANK) return JSON_MODULE_BANK;
  throw new Error(`未找到题库文件，请检查 data/questions.json（${errors.join('；')}）`);
}

/** 取题库（进程内缓存，首次调用时解析并校验） */
export async function getBank() {
  if (cachedBank) return cachedBank;
  if (!loading) {
    loading = loadRaw()
      .then((raw) => { cachedBank = normalize(raw); return cachedBank; })
      .finally(() => { loading = null; });
  }
  return loading;
}

export async function getBankSize() {
  return (await getBank()).length;
}

/** 按题号取题库原题，用于判分（正确答案只存在服务端） */
export async function getQuestionById(id) {
  return (await getBank()).find((q) => q.id === id) || null;
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
 * 下发的题目不含 answer，选项顺序保持题库原样（单选题按 A/B/C/D 展示更符合直觉）。
 */
export async function drawQuestions(count) {
  const bank = await getBank();
  return shuffle(bank)
    .slice(0, Math.min(count, bank.length))
    .map((q) => ({ id: q.id, question: q.question, options: q.options }));
}
