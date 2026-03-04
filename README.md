# Gami Discord Recruitment Plugin

OpenClaw 插件，为 Gami 游戏陪玩平台提供 Discord 招新与私聊对话能力。

**无需 Discord Bot Token。** 所有 Discord 通信通过 OpenClaw 管理的浏览器完成，使用 Chrome DevTools Protocol（CDP）实时读取和发送消息，规避 bot 检测。

## 架构

```
┌─────────────────────────────────────────────────────┐
│                  OpenClaw Gateway                   │
│                                                     │
│  ┌────────────────────────────────────────────┐     │
│  │     gami-discord-recruit plugin            │     │
│  │                                            │     │
│  │  gateway:startup hook                      │     │
│  │    → DiscordBrowserPoller (setInterval)    │     │
│  │         │ poll every 5s via CDP            │     │
│  │         ↓                                  │     │
│  │  Chrome CDP (port 18800)                   │     │
│  │    → evaluate JS in Discord tab            │     │
│  │    → detect unread DMs                     │     │
│  │    → navigate, read messages               │     │
│  │    → Input.insertText + Enter to reply     │     │
│  │         │                                  │     │
│  │         ↓                                  │     │
│  │  Local LLM  http://192.168.8.201:8080/v1   │     │
│  │    POST /chat/completions (openai-compat)  │     │
│  └────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────┘
        ↕ browser CDP
┌─────────────┐
│  Chrome     │  ← logged into discord.com
│  (openclaw  │
│   profile)  │
└─────────────┘
```

## 功能

| 功能 | 实现方式 |
|------|---------|
| 接收 Discord DM | CDP 轮询 Discord web 未读指示器，解析 DOM 消息内容 |
| 发送 Discord DM | CDP `Input.insertText` + `Enter` 模拟真实浏览器输入 |
| 主动招新扫描 | 主 Agent 通过 `discord-recruit` Skill 手动操作浏览器 |
| 私聊独立 LLM | 直接调用 `http://192.168.8.201:8080/v1/chat/completions` |
| 自定义 System Prompt | 插件配置 `systemPrompt` 字段（默认内置 Gami 招新 Prompt） |
| 5 轮后人工接管 | 插件内置轮次计数，自动发送接管通知并停止回复 |

## 文件结构

```
dc-bot-plugin/
├── openclaw.plugin.json     # 插件清单（CDP port、LLM 配置等）
├── package.json             # npm 包（依赖 ws）
├── index.ts                 # 插件主逻辑（CDP 轮询 + LLM 调用）
├── skills/
│   └── discord-recruit/
│       └── SKILL.md         # 主动招新浏览器操作指南
├── AGENTS.md                # 主 Agent 的招新操作指南
├── config-example.json5     # OpenClaw 配置示例
└── README.md                # 本文件
```

## 安装步骤

### 前置要求

- OpenClaw 已安装并运行（Node 22+）
- macOS + Chrome/Brave 浏览器
- 本地 LLM 服务器运行于 `192.168.8.201:8080`（OpenAI-compatible API）

### 1. 安装插件依赖

```bash
cd /Users/m1ro/Mimo/Gami/ai/dc-bot-plugin
npm install
```

### 2. 配置 OpenClaw

将 `config-example.json5` 中的配置合并到 `~/.openclaw/openclaw.json`：

```bash
# 启用浏览器
openclaw config set browser.enabled true --json
openclaw config set browser.headless false --json

# 加载插件
openclaw config set 'plugins.load.paths' '["/Users/m1ro/Mimo/Gami/ai/dc-bot-plugin"]' --json
openclaw config set 'plugins.entries.gami-discord-recruit.enabled' true --json

# 设置 LLM 端点
openclaw config set 'plugins.entries.gami-discord-recruit.config.llmBaseUrl' '"http://192.168.8.201:8080/v1"' --json
openclaw config set 'plugins.entries.gami-discord-recruit.config.llmModel' '"YOUR_MODEL_NAME"' --json
```

**必须替换的值：**

| 配置项 | 说明 |
|--------|------|
| `llmModel` | 本地服务器的模型名（如 `qwen2.5-7b`、`llama-3.1-8b`） |

### 3. 登录 Discord 浏览器

首次使用前，启动浏览器并手动登录 Discord：

```bash
# 启动 OpenClaw 管理的浏览器
openclaw browser --browser-profile openclaw start

# 打开 Discord 登录页
openclaw browser --browser-profile openclaw open https://discord.com/login
```

在打开的 Chrome 窗口中完成 Discord 登录（账号密码或扫码）。登录后浏览器 Session 会保持，无需每次重新登录。

### 4. 重启 Gateway

```bash
openclaw gateway restart
```

验证插件正在运行：

```bash
openclaw plugins list
# 应看到：gami-discord-recruit  enabled

openclaw hooks list
# 应看到：gami-discord.browser-poller-start
```

## 使用方法

### 自动 DM 对话（插件自动处理）

启动后，插件每 5 秒检查一次 Discord 是否有新的未读 DM。

- 有新消息 → 自动调用本地 LLM 生成回复 → 通过浏览器发送
- 前 5 轮：AI 自动回复
- 第 6 轮起：发送人工接管通知，停止 AI 回复

无需任何手动操作。

### 主动招新（通过 Agent 触发）

向主 Agent 发送指令：

```
在 Discord 服务器 [GUILD_ID] 的 [CHANNEL_ID] 频道里找5个活跃用户发招新消息
```

Agent 会使用浏览器 Skill 导航到指定频道，收集活跃用户并逐一发送招新 DM。

### 重置 DM 对话轮数

人工客服跟进完毕后，通过 Agent 或直接调用工具重置计数：

```
帮我重置 Discord 频道 [CHANNEL_ID] 的对话轮数
```

或直接调用 `discord_dm_reset` 工具（channelId = Discord DM 频道 snowflake ID）。

### 查看对话状态

```
查看 Discord 频道 [CHANNEL_ID] 的对话状态
```

调用 `discord_dm_status` 工具，返回当前轮数、剩余轮数、是否已接管。

## 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxDmTurns` | `5` | AI 最多回复几轮后移交人工 |
| `takeoverMessage` | 内置中文通知 | 移交时发给用户的提示语 |
| `pollIntervalMs` | `5000` | 轮询间隔（毫秒） |
| `cdpPort` | `18800` | Chrome CDP 端口（openclaw profile 默认值） |
| `llmBaseUrl` | `http://192.168.8.201:8080/v1` | LLM API base URL |
| `llmModel` | `default` | LLM 模型名 |
| `llmApiKey` | `not-required` | LLM API Key |
| `systemPrompt` | 内置 Gami 招新 Prompt | 对话系统 Prompt（可完全替换） |

修改配置后需重启 Gateway：

```bash
openclaw gateway restart
```

## 注意事项

- **浏览器登录**：Chrome Session 过期后需重新登录 Discord（通常几天/几周有效）
- **招新频率**：Skill 指南中限制每小时 ≤10 条 DM，避免账号被限制
- **CAPTCHA**：如遇验证码，需人工介入；插件会在日志中输出警告
- **轮次存储**：轮数存于内存，Gateway 重启后重置。如需持久化，可扩展 `index.ts` 中的 `ConversationStore` 使用文件或 SQLite 存储
- **多 DM 并发**：插件用 `processing` Set 避免同一频道并发处理，但不同频道会并行处理
- **DOM 稳定性**：Discord 会不定期更新 UI 类名。如选择器失效，参考 `buildGetMessagesJS` 和 `GET_UNREAD_DMS_JS` 函数更新选择器
