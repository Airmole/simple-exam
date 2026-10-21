// 题库加载、解析与校验：题库换了、格式写错了，这里先报警
import { getBank, getBankSize, drawQuestions } from '../edge-functions/api/_lib/questions.js';
import { normalizeChoice, gradeSubmission } from '../edge-functions/api/_lib/scoring.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

console.log('\n[1] 题库解析');
{
  const bank = await getBank();
  check('题库非空', bank.length > 0, String(bank.length));
  check('每题都有 question/options/answer', bank.every(q => q.question && q.options && q.answer));
  check('答案都在选项里', bank.every(q => q.options[q.answer]), JSON.stringify(bank.map(q => q.answer)));
  check('每题至少 2 个选项', bank.every(q => Object.keys(q.options).length >= 2));
  check('id 唯一', new Set(bank.map(q => q.id)).size === bank.length);
  check('getBankSize 与题库一致', (await getBankSize()) === bank.length);
}

console.log('\n[2] 抽题');
{
  const picked = await drawQuestions(3);
  check('抽 3 题', picked.length === 3, String(picked.length));
  check('只返回 id/question/options', picked.every(q => !('answer' in q)));
  const all = await drawQuestions(9999);
  check('题量不足时按题库实际数量出卷', all.length === (await getBankSize()), String(all.length));
  check('题号不重复', new Set(all.map(q => q.id)).size === all.length);
}

console.log('\n[3] 单选作答归一化');
{
  const options = { A: '甲', B: '乙' };
  check('小写转大写', normalizeChoice('a', options) === 'A');
  check('去掉首尾空格', normalizeChoice(' B ', options) === 'B');
  check('不存在的选项视为未作答', normalizeChoice('D', options) === null);
  check('多选视为未作答', normalizeChoice('AB', options) === null);
  check('空值视为未作答', normalizeChoice(null, options) === null);
  check('数字视为未作答', normalizeChoice(1, options) === null);
}

console.log('\n[4] 判分');
{
  const bank = await getBank();
  const q1 = bank[0];
  const q2 = bank[1] || bank[0];
  // 用第 2 题自己的错项，别拿第 1 题的去套
  const wrong = Object.keys(q2.options).find((k) => k !== q2.answer);
  const questions = [{ id: q1.id }, { id: q2.id }];
  const answers = { [q1.id]: q1.answer, [q2.id]: q2.id === q1.id ? q1.answer : wrong };
  const graded = await gradeSubmission(questions, answers, 10);
  check('答对 1 题得 10 分', graded.score === 10, String(graded.score));
  check('逐题明细带正确答案', graded.details.every(d => d.correctAnswer));
  check('错误作答被判定为错', graded.details.filter(d => d.isCorrect).length === 1);
  const empty = await gradeSubmission(questions, {}, 10);
  check('空答卷 0 分', empty.score === 0);
  check('未作答记为 null', empty.details.every(d => d.submittedAnswer === null));
  const ghost = await gradeSubmission([{ id: 987654 }], {}, 10);
  check('题库不存在的题号被跳过', ghost.details.length === 0);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
