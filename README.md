# Gami Discord Recruitment Plugin

OpenClaw 插件，为 Gami 游戏陪玩平台提供 Discord 招新与私聊对话能力。

**无需 Discord Bot Token。** 所有 Discord 通信通过 OpenClaw 管理的浏览器完成，使用 Chrome DevTools Protocol（CDP）实时读取和发送消息，规避 bot 检测。

支持**多机器人并行运行**，每个机器人运行在独立的 OpenClaw 节点上，各自维护独立的 Discord 账号和对话状态。

## 架构

```
OpenClaw Gateway (主节点)
│
├── gami-discord-recruit plugin
│   ├── gateway:startup hook
│   │   └── 为每个配置的 bot 启动一个 DiscordBrowserPoller
│   │
│   ├── DiscordBrowserPoller [bot-local]  ──CDP──▶  本机 Chrome (port 18800)
│   │                                                 Discord 账号 A
│   │
│   ├── DiscordBrowserPoller [bot-node2]  ──CDP──▶  节点2 Chrome (192.168.8.100:18800)
│   │                                                 Discord 账号 B
│   │
│   └── DiscordBrowserPoller [bot-node3]  ──CDP──▶  节点3 Chrome (192.168.8.101:18800)
│                                                     Discord 账号 C
│
└── Local LLM  http://192.168.8.201:8080/v1  (共享 or 按 bot 覆盖)
```

每个 Poller 独立轮询各自 node 的 Chrome → 检测 Discord 未读 DM → 调用 LLM → 通过 CDP 发送回复。

## 功能

| 功能 | 实现方式 |
|------|---------|
| 多机器人并行 | 每个 bot 独立的 CDP 连接 + ConversationStore 命名空间 |
| 接收 Discord DM | CDP 轮询未读指示器，解析 DOM 消息内容 |
| 发送 Discord DM | CDP `Input.insertText` + `Enter` 模拟真实浏览器输入 |
| **主动招新（指定节点）** | `discord_recruit` 工具，在指定 bot 节点上开独立 Tab 执行 |
| 私聊独立 LLM | 直接调用 `/v1/chat/completions`（可按 bot 配置不同端点）|
| 自定义 System Prompt | 全局默认 + 可按 bot 覆盖 |
| 5 轮后人工接管 | 插件内置，ConversationStore 按 `botId:channelId` 隔离 |
| 远端节点支持 | CDP WebSocket URL 自动将 `localhost` 替换为实际 node IP |

## 文件结构

```
dc-bot-plugin/
├── openclaw.plugin.json     # 插件清单（含 bots 数组 schema）
├── package.json             # npm 包（依赖 ws）
├── index.ts                 # 插件主逻辑
├── skills/
│   └── discord-recruit/
│       └── SKILL.md         # 主动招新浏览器操作指南
├── AGENTS.md                # 主 Agent 的招新操作指南
├── config-example.json5     # OpenClaw 配置示例（含多 bot 配置）
└── README.md                # 本文件
```

## 安装步骤

### 1. 安装依赖

```bash
cd /Users/m1ro/Mimo/Gami/ai/dc-bot-plugin
npm install
```

### 2. 配置各节点（每台机器）

每台运行 bot 的机器都需要：

**a. 安装并启动 OpenClaw（作为节点）**

**b. 启用浏览器**

```bash
openclaw config set browser.enabled true --json
openclaw config set browser.headless false --json
openclaw config set 'browser.profiles.openclaw.cdpPort' 18800 --json
```

**c. 登录 Discord（每台机器用不同账号）**

```bash
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://discord.com/login
# 在打开的 Chrome 窗口中完成 Discord 登录
```

登录完成后 Session 会保持（无需每次重新登录）。

**d. 确保 CDP 端口可从主节点访问**

如果 Chrome 运行在远端节点，需要确保主节点可以访问对应的 CDP 端口（默认 18800）。

> **注意**：CDP 端口暴露后任何同网络的机器都可控制该浏览器，建议限制在内网访问或使用 VPN。

### 3. 在主节点配置插件

```bash
# 加载插件
openclaw config set 'plugins.load.paths' '["/Users/m1ro/Mimo/Gami/ai/dc-bot-plugin"]' --json
openclaw config set 'plugins.entries.gami-discord-recruit.enabled' true --json
```

然后编辑 `~/.openclaw/openclaw.json`，参考 `config-example.json5` 的 `bots` 数组配置各机器人：

```json5
{
  plugins: {
    entries: {
      "gami-discord-recruit": {
        config: {
          llmBaseUrl: "http://192.168.8.201:8080/v1",
          llmModel: "qwen2.5-7b",
          bots: [
            { id: "bot-local",  label: "本地机器人",  cdpHost: "127.0.0.1",    cdpPort: 18800 },
            { id: "bot-node2",  label: "节点2机器人",  cdpHost: "192.168.8.100", cdpPort: 18800 },
            { id: "bot-node3",  label: "节点3机器人",  cdpHost: "192.168.8.101", cdpPort: 18800 },
          ]
        }
      }
    }
  }
}
```

### 4. 重启 Gateway

```bash
openclaw gateway restart
```

启动日志中应看到：

```
[gami-discord] Starting 3 bot(s)...
[gami-discord:bot-local] Starting poller — node 127.0.0.1:18800
[gami-discord:bot-node2] Starting poller — node 192.168.8.100:18800
[gami-discord:bot-node3] Starting poller — node 192.168.8.101:18800
```

## 使用方法

### 查看所有机器人状态

```
列出所有 Discord 机器人的状态
```

调用 `discord_bots_list` 工具，返回每个 bot 的 node 地址、是否运行中、活跃对话列表。

### 自动 DM 对话

无需操作。每个 bot 自动轮询各自 node 的 Discord，检测未读 DM 后：

1. 调用本地 LLM 生成回复
2. 通过 CDP 发送到 Discord
3. 前 N 轮（默认5轮）AI 自动处理
4. 超过轮数后发送接管通知并停止

### 主动招新（指定 bot 节点）

```
用 bot-node2 在服务器 [GUILD_ID] 的 [CHANNEL_ID] 频道里找5个活跃用户发招新消息
```

调用 `discord_recruit` 工具，指定 `botId`，插件会在该 bot 对应节点的 Chrome 上**开启独立 Tab**，自动完成：扫描在线成员 → 逐个打开 DM → 发送招新话术 → 关闭 Tab，不影响该 bot 的 DM 自动回复轮询。

工具参数：

| 参数 | 必填 | 说明 |
|------|------|------|
| `botId` | 多 bot 时必填 | 要使用的 bot ID（由 `discord_bots_list` 查询）|
| `guildId` | ✅ | Discord 服务器 ID |
| `channelId` | ✅ | 目标频道 ID |
| `count` | 可选 | 本次联系人数（默认 5，最大 10）|
| `message` | 可选 | 自定义话术；省略则轮换内置 Gami 模板 |

返回示例：

```json
{
  "botId": "bot-node2",
  "guildId": "123456789",
  "channelId": "987654321",
  "contacted": ["PlayerA", "PlayerB", "PlayerC"],
  "skipped": ["PlayerD: Message button not found in popup"],
  "errors": []
}
```

**注意**：工具在两条 DM 之间自动等待 15–45 秒，单次最多 10 条，符合反检测要求。

### 查看某 bot 的对话状态

```
查看机器人 bot-node2 在频道 123456789 的对话状态
```

调用 `discord_dm_status`，参数：`botId: "bot-node2"`, `channelId: "123456789"`。

### 重置 DM 对话轮数

人工客服跟进完毕后重置：

```
重置机器人 bot-local 在频道 987654321 的对话
```

调用 `discord_dm_reset`，参数：`botId: "bot-local"`, `channelId: "987654321"`。

## 配置参数

### 全局参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxDmTurns` | `5` | AI 最多回复几轮 |
| `takeoverMessage` | 内置中文通知 | 移交时发给用户的提示语 |
| `pollIntervalMs` | `5000` | 轮询间隔（毫秒，所有 bot 共享）|
| `cdpHost` | `127.0.0.1` | 单 bot 模式的默认 CDP host |
| `cdpPort` | `18800` | 单 bot 模式的默认 CDP port |
| `llmBaseUrl` | `http://192.168.8.201:8080/v1` | LLM API base URL |
| `llmModel` | `default` | LLM 模型名 |
| `llmApiKey` | `not-required` | LLM API Key |
| `systemPrompt` | 内置 Gami 招新 Prompt | 对话系统 Prompt |

### 每个 bot 的参数（在 `bots[]` 数组中）

| 参数 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 唯一 bot 标识，工具调用时使用 |
| `label` | 可选 | 友好名称，用于日志显示 |
| `cdpHost` | 可选 | 此 bot 对应 node 的 IP（默认继承全局） |
| `cdpPort` | 可选 | 此 bot 对应 node 的 CDP 端口（默认继承全局）|
| `maxDmTurns` | 可选 | 覆盖全局值 |
| `takeoverMessage` | 可选 | 覆盖全局值 |
| `systemPrompt` | 可选 | 覆盖全局值 |
| `llmBaseUrl` | 可选 | 覆盖全局值（可让不同 bot 使用不同 LLM）|
| `llmModel` | 可选 | 覆盖全局值 |
| `llmApiKey` | 可选 | 覆盖全局值 |

## 注意事项

- **单 bot 模式**：不配置 `bots` 数组时，使用全局 `cdpHost`/`cdpPort` 作为单 bot 运行（向下兼容）
- **Chrome 登录保持**：Session 过期后需在对应 node 重新登录 Discord
- **CDP 安全**：CDP 端口建议只在内网访问，不要暴露到公网
- **DOM 选择器**：Discord 可能更新 UI 类名，如失效参考 `index.ts` 中的 `GET_UNREAD_DMS_JS` 和 `buildGetMessagesJS` 函数更新
- **轮次计数**：存储在内存中，Gateway 重启后重置
- **并发保护**：同一 bot 内同一频道不会并发处理，不同频道并行处理
