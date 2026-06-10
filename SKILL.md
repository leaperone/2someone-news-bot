# 2SOMEone Bot 开发（写给 AI 编程助手）

你正在改造一个 2SOMEone 平台机器人。本文件给你稳定的平台上下文，避免猜测。

## 平台事实

- Base URL：`https://2some.ren`（可被 `TWOSOMEONE_BASE_URL` 覆盖）
- 鉴权：所有请求带 header `x-api-key: <bot runtime key>`，key 以 `sk_` 开头
- runtime key 来自环境变量 `TWOSOMEONE_BOT_API_KEY`，**绝不**写死在代码或提交进 git
- 机器人身份验证：`GET /api/auth/get-session` → `{ user: { id, username, accountType } }`，必须校验 `accountType === "bot"`

## 已实装的机器人能力（其余都不存在，不要编造）

| 能力 scope | 端点 | 约束 |
|---|---|---|
| `bubble.create` | `POST /api/v1/bubbles`，body `{ content }` | content ≤500 字；有内容审核与限流（429 时退避重试） |
| `bubble.read` | `GET /api/v1/bubbles?authorId=<botId>&limit=N` | **只能读机器人自己发布的**；N ≤ 50 |
| `chat.send` | `POST /api/v1/chat/conversations/<id>/messages`，body `{ text }` | 机器人必须先被安装到该群聊 |

未实装（不要尝试）：读他人泡泡 / 讨论串、点赞、转发、收消息、webhook 回调、图片上传。

## 内容规则

- `content` 里的 `#词` 会成为话题标签，`@username` 会真实通知对应用户——转发外部内容时把 `@` 替换为全角 `＠` 避免骚扰
- 单次运行控制发布条数（本模板默认 3 条），机器人刷屏会被用户屏蔽、被平台限流

## 本仓库结构

- `index.mjs` — 全部逻辑。`api()` / `preflight()` / `postBubble()` 是平台交互层，改造时保留；RSS 部分是示例数据源，可整体替换
- `feeds.json` — RSS 源配置
- `.github/workflows/post-news.yml` — 每小时 schedule + 手动 dispatch（带 dry_run 输入）

## 改造守则

1. 先跑 `DRY_RUN=1 node index.mjs` 验证，再考虑真实发布
2. 去重必须无状态：用 `bubble.read` 读自己最近发布的内容判重，不要引入数据库
3. 保持零基础设施：单脚本 + GitHub Actions schedule 就是部署形态
4. 管理机器人账号（创建 / 改能力 / 轮换 key）用 2SOMEone CLI：`2s1 bot --help`，那是另一把 key（human account key），与 runtime key 不可混用
