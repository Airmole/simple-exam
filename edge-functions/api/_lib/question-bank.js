// 题库：由 data/questions.json 生成，随函数一起打包，避免 JSON 导入断言在 Edge Runtime 的兼容问题
// 修改题库时优先改 data/questions.json；这里作为无法导入 JSON 时的兜底来源。
export const QUESTION_BANK = [
  {
    "id": 1,
    "question": "单选题的答案在题库里用哪个字段表示？",
    "options": {
      "A": "answer",
      "B": "correct",
      "C": "result",
      "D": "key"
    },
    "answer": "A"
  },
  {
    "id": 2,
    "question": "本系统判分发生在哪一侧？",
    "options": {
      "A": "浏览器",
      "B": "服务端",
      "C": "CDN 边缘缓存",
      "D": "数据库触发器"
    },
    "answer": "B"
  },
  {
    "id": 3,
    "question": "题库文件默认放在仓库的哪个目录？",
    "options": {
      "A": "public/",
      "B": "edge-functions/",
      "C": "data/",
      "D": "test/"
    },
    "answer": "C"
  },
  {
    "id": 4,
    "question": "每道题的 id 的作用是？",
    "options": {
      "A": "仅用于排序",
      "B": "判分与解析时定位原题",
      "C": "决定分值",
      "D": "展示给考生的题号"
    },
    "answer": "B"
  },
  {
    "id": 5,
    "question": "默认配置下，抽题数量由哪个环境变量控制？",
    "options": {
      "A": "EXAM_DURATION_MINUTES",
      "B": "EXAM_PASS_SCORE",
      "C": "EXAM_QUESTION_COUNT",
      "D": "EXAM_MAX_ATTEMPTS"
    },
    "answer": "C"
  },
  {
    "id": 6,
    "question": "想看逐题解析而不公开正确答案，应把 EXAM_SHOW_ANSWER 设为？",
    "options": {
      "A": "true",
      "B": "false",
      "C": "1",
      "D": "可以留空"
    },
    "answer": "B"
  },
  {
    "id": 7,
    "question": "同一用户多次考试，成绩排名取哪一次？",
    "options": {
      "A": "最近一次",
      "B": "第一次",
      "C": "最高分（同分取用时短）",
      "D": "平均分"
    },
    "answer": "C"
  },
  {
    "id": 8,
    "question": "数据持久化默认使用 EdgeOne 的哪项能力？",
    "options": {
      "A": "KV 存储",
      "B": "对象存储",
      "C": "云数据库",
      "D": "本地磁盘"
    },
    "answer": "A"
  },
  {
    "id": 9,
    "question": "截止时间 EXAM_DEADLINE 按哪个时区解析？",
    "options": {
      "A": "UTC",
      "B": "北京时间 UTC+8",
      "C": "浏览器本地时区",
      "D": "服务器所在时区"
    },
    "answer": "B"
  },
  {
    "id": 10,
    "question": "选项至少需要几个才能通过题库校验？",
    "options": {
      "A": "1 个",
      "B": "2 个",
      "C": "4 个",
      "D": "必须正好 4 个"
    },
    "answer": "B"
  },
  {
    "id": 11,
    "question": "考试时长按哪个变量配置？",
    "options": {
      "A": "EXAM_DURATION_MINUTES",
      "B": "EXAM_DURATION_SECONDS",
      "C": "EXAM_TIMEOUT",
      "D": "SESSION_TTL"
    },
    "answer": "A"
  },
  {
    "id": 12,
    "question": "提交答卷时答案用什么格式传给服务端？",
    "options": {
      "A": "数组，按题目顺序",
      "B": "题号到选项字母的映射",
      "C": "逗号分隔的选项串",
      "D": "正确答案列表"
    },
    "answer": "B"
  }
];
