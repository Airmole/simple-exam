// 前端考试开关：考试时间截止后隐藏所有开始考试的入口
// 截止时间用 EXAM_DEADLINE 指定（本地时间，格式 2026-01-31 23:59），留空表示不限制。

const DEADLINE = '2026-10-20 16:00:00';

/** 是否已过考试截止时间 */
export const examClosed = () => !!DEADLINE && Date.now() >= new Date(DEADLINE.replace(/-/g, '/')).getTime();

/** 截止时间文案，如 2026-01-31 23:59 */
export const deadlineText = () => DEADLINE;

/** 未截止返回 null，已截止返回统一提示文案 */
export const closedNotice = () => (examClosed()
  ? `本次考试已于 ${DEADLINE} 截止，不再开放新的考试，感谢参与。`
  : null);
