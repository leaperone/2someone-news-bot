# 2SOMEone 资讯机器人

2SOMEone 官方资讯机器人，也是**社区机器人模板**：定时拉取 RSS，把新鲜事发布成[泡泡动态](https://2some.ren)。

它不享受任何内部特权——只用公开的 v1 API + bot runtime key，和你能做出来的机器人一模一样。**Fork 这个仓库，10 分钟拥有你自己的机器人，不需要服务器。**

## 工作原理

```
GitHub Actions（每小时） → 拉取 feeds.json 里的 RSS 源
  → 过滤最近 24 小时的新条目
  → 读取机器人自己发过的泡泡去重（无状态，不需要数据库）
  → POST /api/v1/bubbles 发布（单次最多 3 条，防刷屏）
```

核心只有一个文件 [`index.mjs`](./index.mjs)（约 200 行），唯一依赖是 `rss-parser`。

## Fork 之后做三件事

### 1. 创建你的机器人账号

安装 2SOMEone CLI 并登录，然后：

```bash
2s1 bot create --username my_news --nickname "我的资讯姬" \
  --capability bubble.create --capability bubble.read

# 获取 runtime key（只显示一次，立即保存）
2s1 bot key rotate <botUserId> --yes
```

> 普通账号每人最多 3 个机器人；`bubble.create` + `bubble.read` 两个能力本机器人都需要（read 用于去重）。

### 2. 配置 Secret

在你 fork 的仓库里：**Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `TWOSOMEONE_BOT_API_KEY` | 上一步拿到的 `sk_...` runtime key |

### 3. 启用 Actions 并测试

Fork 的仓库默认禁用 schedule workflow，去 **Actions** 标签页启用，然后手动跑一次 **Post news** workflow（勾选 `dry_run` 先看效果，不会真实发布）。

完成。之后每小时自动检查更新。

## 自定义

### 换 RSS 源

编辑 [`feeds.json`](./feeds.json)：

```json
[
  { "name": "来源显示名", "url": "https://example.com/feed.xml" }
]
```

任何标准 RSS / Atom 源都可以。没有官方 RSS 的站点可以用 [RSSHub](https://docs.rsshub.app/) 生成（建议自建实例，公共实例可能不稳定）。

### 调参数

通过环境变量（可在 workflow 的 `env:` 里加）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAX_POSTS_PER_RUN` | `3` | 单次运行最多发布条数 |
| `FRESH_WINDOW_HOURS` | `24` | 只发布最近 N 小时内的新闻 |
| `TWOSOMEONE_BASE_URL` | `https://2some.ren` | 平台地址 |
| `DRY_RUN` | - | 设为 `1` 只打印不发布 |

### 本地运行

```bash
pnpm install
TWOSOMEONE_BOT_API_KEY=sk_xxx pnpm run dry-run   # 预览
TWOSOMEONE_BOT_API_KEY=sk_xxx pnpm start          # 真实发布
```

## 改成别的机器人

这个模板的「RSS → 泡泡」只是示例。把 `index.mjs` 里的 RSS 部分换成任何数据源（天气、汇率、GitHub releases、你自己的服务……），保留 `api()` / `preflight()` / `postBubble()` 几个函数即可。

把仓库丢给 AI 编程助手（Claude Code / Codex）改造效果最好——[`SKILL.md`](./SKILL.md) 就是写给它们看的。

## 平台 API 速查

| 能力 | 端点 | 说明 |
|---|---|---|
| 身份验证 | `GET /api/auth/get-session` | header `x-api-key: sk_...`，返回 `user.accountType === "bot"` |
| 发布泡泡 | `POST /api/v1/bubbles` | body `{ "content": "≤500 字" }`，需要 `bubble.create` 能力 |
| 读自己的泡泡 | `GET /api/v1/bubbles?authorId=<botId>&limit=50` | 需要 `bubble.read` 能力，只能读自己发布的 |
| 群聊发消息 | `POST /api/v1/chat/conversations/<id>/messages` | body `{ "text": "..." }`，需要 `chat.send` 能力 + 已安装到群聊 |

所有请求都带 `x-api-key` header。写操作有平台限流与内容审核。

## License

MIT
