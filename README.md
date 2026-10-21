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
| 考试截止 | 截止后隐藏所有开始考试的入口（首页、排名页、成绩页、答题页），提示已到截止时间 |
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
  js/{app,api,util,components,config}.js
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
    store.js                   # KV 数据模型、key 规范与统计
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

项目设置 → **KV 存储** → 绑定命名空间，**变量名填 `EXAM_KV`**（与 `KV_BINDING` 一致）。

> 绑定名不是环境变量：EdgeOne 会把它注入成运行时**全局变量**，函数里直接 `EXAM_KV.get(...)` 访问，
> 不在 `context.env` 上。`getKV()` 优先读全局，其次兼容 `env[绑定名]`。

### 1.1 排查「未找到 KV 绑定」

按顺序看：

1. 绑定是不是加在**这个**项目上（同名项目容易点错），且变量名与 `KV_BINDING` 完全一致（大小写敏感）。
2. 绑定是在**当前生效的那次部署之后**才加的 —— 在「部署」里对最新提交重新构建一次，函数才会拿到新绑定。
3. 看接口返回：`/api/*` 现在会返回 `503 { code: "KV_BINDING_MISSING", binding: "EXAM_KV", error: "..." }`，
   `error` 里会带上运行时实际读到的同名值类型，能区分「没读到」和「读到了但不是 KV 对象」。

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

### 4.1 若回调停留在 `invalid_client`

`/api/auth/callback` 返回 `换取 token 失败: 400 invalid_client` 说明 OneID 没认下客户端凭据。
token 请求默认先发 `client_secret_basic`（RFC 6749 §2.3.1：先 urlencode 再 base64），
拿到 `invalid_client` 会自动改用 `client_secret_post` 重试一次；两种都失败才会报错，
错误信息里会注明试过哪几种方式。

排错顺序：

1. `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` 是否与 OneID 应用配置完全一致（多余空格也算不一致）。
2. 密钥里若有非 ASCII 字符（中文等），`Basic` 头承载不了，把 `OIDC_CLIENT_AUTH_METHOD` 设为 `post`。
3. 改完配置后对最新提交**重新部署**，边缘函数不会自动读取新的环境变量。

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
| `OIDC_CLIENT_AUTH_METHOD` | 空（先 `basic` 再 `post`） | 客户端认证方式。`basic` 走 `Authorization` 头，`post` 把凭据放表单；凭据非 ASCII 或反代改写 header 时用 `post` |
| `OIDC_SCOPES` | `openid profile` | 申请 scope |
| `SESSION_SECRET` | 回退用 client secret | 会话签名/加密密钥，建议单独配置 |
| `EXAM_QUESTION_COUNT` | `50` | 抽题数量 |
| `EXAM_POINTS_PER_QUESTION` | `2` | 每题分值 |
| `EXAM_PASS_SCORE` | `80` | 及格分 |
| `EXAM_DURATION_MINUTES` | `60` | 考试时长（分钟） |
| `ADMIN_USERS` | 空 | 管理后台白名单，逗号分隔 |
| `KV_BINDING` | `EXAM_KV` | KV 绑定的运行时变量名（控制台「KV 存储 → 绑定命名空间」里填的名字） |

> 考试截止时间在前端配置：`public/js/config.js` 里的 `DEADLINE`（本地时间，如 `2026-01-31 23:59`）。
> 留空表示不限；填一个过去的时间即进入截止状态，页面会隐藏所有开始考试入口并统一提示，无需重新部署后端。

> `ADMIN_USERS` 支持填 OneID 的 `preferred_username`、`email`、`mobile` 或 `sub`，匹配时忽略大小写。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/auth/login?returnTo=` | 跳转 OneID 授权 |
| GET | `/api/auth/callback` | 授权回调，换取用户信息并建会话 |
| GET | `/api/auth/logout` | 清除会话并跳转 OneID `/authz/fclogout`（带 `client_id`、`post_logout_redirect_uri`、`id_token_hint`；URL 过长时改为自动提交的 POST 表单） |
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
| `exam_record_<id>` | 单次答题记录，含逐题明细（题目、正确答案、用户答案） |
| `exam_user_<sub>` | 用户索引：全部记录 ID、最高分、最快用时、考试次数 |
| `exam_paper_<sub>` | 进行中的试卷（含 TTL，用于服务端判分） |
| `exam_stats` | 汇总统计：人数、次数、合格数、分数和、最快/最慢用时 |

EdgeOne KV 的 key 只允许**数字、字母、下划线**（≤ 512B），所以分隔符用 `_`，
`sub` 里的 `:`、`.`、`-` 等字符会先编码成 `_`（见 `store.js` 的 `keySegment`）。

排名不额外落库，由 `exam_record_` 前缀扫描后在内存聚合，避免维护多份索引导致不一致。

> EdgeOne KV 为最终一致性（跨节点最长 60s 可见），排名与统计的秒级延迟属预期行为。

> `kv.list()` 的 `cursor` 是**严格字符串**：首次查询不能带这个字段，带 `undefined` 会直接抛
> `cursor type invalid. expect: 'string' get: 'undefined'`。分页统一走 `store.js` 的 `listAllKeys()`，
> 它只在拿到非空 cursor 时才续翻。空数据池同样会走一次前缀扫描，所以这个坑和「有没有人答题」无关。

## 本地开发与测试

```bash
# 集成测试 + 认证单元测试（无需网络与 KV）
node test/run.mjs
node test/auth.mjs

# 本地开发服务器（自带 mock OIDC，无需真实 OneID）
node test/dev-server.mjs
# 打开 http://127.0.0.1:8787
```

本地开发服务器把 mock KV 挂在全局 `EXAM_KV` 上，和 EdgeOne 线上行为一致；
`mock-kv.js` 还会校验 key 字符合法性，key 写错在本地就会报错。

本地登录：访问 `/api/auth/login`，mock 提供方默认签发「李四」；
把跳转到的 `/mock-oidc/authorize` 地址末尾加上 `&user=code_admin` 即以管理员身份登录。

## 安全说明

- 正确答案仅存于服务端，`/api/exam/start` 下发的题目不含 `answer` 字段，判分在提交时以题库为准。
- 试卷落 KV 并带 TTL；即便 KV 跨节点暂未命中，交卷时也用服务端题库按题号判分，不接受前端传入的正确答案。
- 会话 Cookie 为 HttpOnly + SameSite=Lax，载荷经 AES-GCM 加密并用 HMAC-SHA256 签名，密钥即 `SESSION_SECRET`。
- OIDC 使用授权码 + PKCE（S256）与 state 校验，防重放与 CSRF。
- 管理后台在服务端做白名单校验，前端仅控制入口显示。

