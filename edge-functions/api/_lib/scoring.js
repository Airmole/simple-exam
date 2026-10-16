// 判分：正确答案只存在服务端，前端永远拿不到
import { answerOf } from './questions.js';

export function gradeSubmission(questions, answers, pointsPerQuestion) {
  const details = questions.map((q) => {
    const correct = answerOf(q.id);
    const submitted = answers && answers[q.id] != null ? String(answers[q.id]).toUpperCase() : null;
    return {
      id: q.id,
      question: q.question,
      options: q.options,
      correctAnswer: correct,
      submittedAnswer: submitted,
      isCorrect: submitted !== null && submitted === correct,
    };
  });
  const correctCount = details.filter((d) => d.isCorrect).length;
  return { details, correctCount, score: correctCount * pointsPerQuestion };
}
