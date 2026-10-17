# 大疆机场 4 认证考试系统

一个部署在腾讯云 EdgeOne（Makers / Pages）上的 Web 考试系统：

- 登录：腾讯统一身份认证 OneID（OIDC 授权码 + PKCE）
- 后端：EdgeOne **Edge Functions**（`/edge-functions` 目录，Edge Runtime）
- 存储：EdgeOne **KV 存储**
- 前端：原生 HTML/CSS/JS，无构建步骤，构建时直接作为静态资源输出

## 功能一览

| 模块 | 说明 |
| --- | --- |
| 登录认证 | OneID OIDC 授权码 + PKCE，会话用 AES-GCM 加密 + HMAC 签名的 HttpOnly Cookie |
| 考试规则 | 开始前展示题目数、每题分数、满分、及格分、时长；有后台权限才显示入口 |
| 答题过程 | 实时显示开始时间、已用时长、剩余时长、已答题数、剩余题目、当前题的原题号；答题卡可跳转 |
| 交卷判分 | 服务端判分（正确答案不下发前端），满分 100，80 分合格；不合格提示重考 |
| 成绩记录 | 姓名、开始/结束时间、用时、逐题作答（题目 + 正确答案 + 用户答案） |
| 成绩排名 | 全员可看；同一用户取最高分，同分用时短者靠前 |
| 管理后台 | 仅白名单用户可访问；考试人数、次数、合格率、平均分、最高/最低分、最快/最慢答题，以及答题记录与详情 |

## 目录结构

```
data/questions.json            # 题库（100 题）
public/                        # 静态前端（构建输出目录）
  index.html
  css/style.css
  js/{app,api,util,components}.js
  js/pages/{home,exam,result,ranking,admin}.js
edge-functions/
  api/[[default]].js           # 统一入口，/api/* 全走这里
  api/_lib/
    router.js                  # 路由分发
    oidc.js                    # OneID OIDC 客户端与会话
    crypto.js                  # Web Crypto 工具
    config.js                  # 环境变量读取
    questions.js               # 题库与随机抽题
    scoring.js                 # 判分
    store.js                   # KV 数据模型与统计
    http.js                    # 响应工具
test/                          # 本地测试（不入生产构建）
  run.mjs                      # 接口集成测试
  auth.mjs                     # 认证与加密单元测试
  dev-server.mjs               # 本地开发服务器（含 mock OIDC）
  mock-kv.js                   # 内存 KV
```

## 部署到 EdgeOne

### 1. 开通 KV 并创建命名空间

控制台 → **Pages → 存储 → KV 存储** → 申请开通账户 → 创建命名空间（免费版 1GB）。

### 2. 创建 Makers 项目

导入本仓库，构建配置：

| 项 | 值 |
| --- | --- |
| 根目录 | `./` |
| 构建命令 | 留空（无构建步骤） |
| 输出目录 | `public` |

### 3. 绑定 KV 命名空间

项目设置 → 存储绑定 → 选择上一步的命名空间，**变量名填 `EXAM_KV`**（与 `KV_BINDING` 一致，否则接口报「未找到 KV 绑定」）。

### 4. 配置环境变量

项目设置 → 环境变量，按 `.env.example` 填写，关键几项：

```
SITE_URL=https://dji-exam.airmole.cn
OIDC_ISSUER=https://oauth2.account.tencent.com/authz/oidc/v2/1492474500942414067
OIDC_CLIENT_ID=<客户端ID>
OIDC_CLIENT_SECRET=<客户端密钥>
SESSION_SECRET=<openssl rand -hex 32>
ADMIN_USERS=admin@corp.com,zhangsan
EXAM_DURATION_MINUTES=60
```

### 5. 在 OneID 侧登记回调地址

在腾讯统一身份认证的应用配置里，把回调地址设为：

```
https://dji-exam.airmole.cn/api/auth/callback
```

（本地调试时改为 `http://127.0.0.1:8787/api/auth/callback`）

### 6. 绑定域名

把 `dji-exam.airmole.cn` 解析到 Makers 项目；`SITE_URL` 必须与之一致，否则回调域名校验会失败。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SITE_URL` | 请求 origin | 站点地址，用于拼接回调与登出跳转 |
| `OIDC_ISSUER` | — | OneID issuer |
| `OIDC_CLIENT_ID` | — | 客户端 ID |
| `OIDC_CLIENT_SECRET` | — | 客户端密钥 |
| `OIDC_SCOPES` | `openid profile` | 申请 scope |
| `SESSION_SECRET` | 回退用 client secret | 会话签名/加密密钥，建议单独配置 |
| `EXAM_QUESTION_COUNT` | `50` | 抽题数量 |
| `EXAM_POINTS_PER_QUESTION` | `2` | 每题分值 |
| `EXAM_PASS_SCORE` | `80` | 及格分 |
| `EXAM_DURATION_MINUTES` | `60` | 考试时长（分钟） |
| `ADMIN_USERS` | 空 | 管理后台白名单，逗号分隔 |
| `KV_BINDING` | `EXAM_KV` | KV 绑定的运行时变量名 |

> `ADMIN_USERS` 支持填 OneID 的 `preferred_username`、`email`、`mobile` 或 `sub`，匹配时忽略大小写。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/auth/login?returnTo=` | 跳转 OneID 授权 |
| GET | `/api/auth/callback` | 授权回调，换取用户信息并建会话 |
| GET | `/api/auth/logout` | 清除会话并跳转 OneID 登出 |
| GET | `/api/auth/me` | 当前登录态、是否管理员、考试规则 |
| GET | `/api/meta` | 站点信息（题库总量、规则、登录态） |
| GET | `/api/exam/rules` | 考试规则 |
| POST | `/api/exam/start` | 抽题开考，返回题目（不含答案）与起止时间 |
| GET | `/api/exam/questions` | 取整卷或单题（`?index=N`） |
| POST | `/api/exam/submit` | 交卷判分并落库 |
| GET | `/api/ranking` | 成绩排名（公开） |
| GET | `/api/admin/stats` | 统计指标（仅管理员） |
| GET | `/api/admin/records` | 答题记录列表（仅管理员） |
| GET | `/api/admin/record?id=` | 单条记录详情（仅管理员） |

## 数据模型（KV）

| Key | 内容 |
| --- | --- |
| `exam:record:<id>` | 单次答题记录，含逐题明细（题目、正确答案、用户答案） |
| `exam:user:<sub>` | 用户索引：全部记录 ID、最高分、最快用时、考试次数 |
| `exam:paper:<sub>` | 进行中的试卷（含 TTL，用于服务端判分） |
| `exam:stats` | 汇总统计：人数、次数、合格数、分数和、最快/最慢用时 |

排名不额外落库，由 `exam:record:` 前缀扫描后在内存聚合，避免维护多份索引导致不一致。

> EdgeOne KV 为最终一致性（跨节点最长 60s 可见），排名与统计的秒级延迟属预期行为。

## 本地开发与测试

```bash
# 集成测试 + 认证单元测试（无需网络与 KV）
node test/run.mjs
node test/auth.mjs

# 本地开发服务器（自带 mock OIDC，无需真实 OneID）
node test/dev-server.mjs
# 打开 http://127.0.0.1:8787
```

本地登录：访问 `/api/auth/login`，mock 提供方默认签发「李四」；
把跳转到的 `/mock-oidc/authorize` 地址末尾加上 `&user=code_admin` 即以管理员身份登录。

## 安全说明

- 正确答案仅存于服务端，`/api/exam/start` 下发的题目不含 `answer` 字段，判分在提交时以题库为准。
- 试卷落 KV 并带 TTL；即便 KV 跨节点暂未命中，交卷时也用服务端题库按题号判分，不接受前端传入的正确答案。
- 会话 Cookie 为 HttpOnly + SameSite=Lax，载荷经 AES-GCM 加密并用 HMAC-SHA256 签名，密钥即 `SESSION_SECRET`。
- OIDC 使用授权码 + PKCE（S256）与 state 校验，防重放与 CSRF。
- 管理后台在服务端做白名单校验，前端仅控制入口显示。

