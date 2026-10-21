// 判分：正确答案只存在服务端，前端永远拿不到
import { getQuestionById } from './questions.js';

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// 只接受单个选项字母（A~H），多项、非法值一律视为未作答
export function normalizeChoice(raw, options) {
  if (raw == null) return null;
  const value = String(raw).trim().toUpperCase();
  if (!OPTION_KEYS.includes(value)) return null;
  if (options && !(value in options)) return null;
  return value;
}

export async function gradeSubmission(questions, answers, pointsPerQuestion) {
  const details = [];
  for (const q of questions) {
    const bank = await getQuestionById(q.id);
    if (!bank) continue;
    const submitted = normalizeChoice(answers ? answers[q.id] : null, bank.options);
    details.push({
      id: bank.id,
      question: bank.question,
      options: bank.options,
      correctAnswer: bank.answer,
      submittedAnswer: submitted,
      isCorrect: submitted === bank.answer,
    });
  }
  const correctCount = details.filter((d) => d.isCorrect).length;
  return { details, correctCount, score: correctCount * pointsPerQuestion };
}
