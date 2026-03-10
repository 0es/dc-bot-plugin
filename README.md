# Gami Discord Recruitment Plugin

OpenClaw 插件，为 Gami 游戏陪玩平台提供 Discord 招新与私聊对话能力。

**无需 Discord Bot Token。** 所有 Discord 通信通过 Chrome DevTools Protocol（CDP）直接操作浏览器完成，规避 bot 检测。

支持**多机器人并行运行**，每个机器人运行在独立的机器上，各自维护独立的 Discord 账号和对话状态。

## 架构

```
OpenClaw Gateway（主节点）
│
└── gami-discord-recruit plugin
    │  配置中每个 bot 对应一个 workerUrl
    │
    ├── WorkerClient [bot-local]  ──HTTP──▶  node-worker :3000  ──CDP──▶  本机 Chrome
    │                                          Discord 账号 A
    │
    ├── WorkerClient [bot-node2]  ──HTTP──▶  node-worker :3000  ──CDP──▶  节点2 Chrome
    │                                  (192.168.8.100)             Discord 账号 B
    │
    └── WorkerClient [bot-node3]  ──HTTP──▶  node-worker :3000  ──CDP──▶  节点3 Chrome
                                       (192.168.8.101)             Discord 账号 C
```

**关键设计：**

- **招新**：由 **Gateway AI** 通过 OpenClaw 的 node 端 **browser 工具**（navigate / snapshot / act）控制该 node 上的 Chrome，在 Discord 频道找活跃用户并发送 DM。招新不由 node-worker 执行。
- **私聊回复**：每台 bot 机器运行一个 **node-worker** 进程，只负责：本地连接 Chrome CDP、轮询 Discord 未读 DM、调用 LLM、发送回复；并暴露 HTTP API（默认 `:3000`）供 gateway plugin 查询状态与重置会话。

Gateway plugin 通过 HTTP 与各 node-worker 通信（状态、DM 重置），不直接接触 CDP。

## 功能

| 功能 | 实现方式 |
|------|---------|
| 多机器人并行 | 每台机器独立 node-worker，各自维护会话状态 |
| 接收 Discord DM | node-worker CDP 轮询 + Vencord dcBotPlugin 读取 MessageStore |
| 发送 Discord DM | Vencord dcBotPlugin sendMessage（内部 API）|
| **主动招新** | Gateway AI 控制 node 端浏览器（navigate / snapshot / act）完成；node-worker 不参与 |
| 私聊 LLM 对话 | node-worker 直接调用 `/v1/chat/completions` |
| 自定义 System Prompt | node-worker 环境变量 `SYSTEM_PROMPT` |
| 5 轮后人工接管 | node-worker 内置，会话状态存本地内存 |

## 文件结构

```
dc-bot-plugin/
├── openclaw.plugin.json       # 插件清单（workerUrl 配置 schema）
├── package.json               # plugin 包（无外部依赖）
├── index.ts                   # 插件入口
├── src/
│   ├── types.ts               # Plugin 类型定义
│   ├── config.ts              # 配置解析
│   ├── constants.ts           # 默认值
│   ├── logger.ts              # 日志封装
│   ├── worker-client.ts       # node-worker HTTP 客户端
│   └── service.ts             # 工具注册与路由
├── node-worker/               # 节点 Worker（每台 bot 机器部署；DM 能力依赖 Vencord dcBotPlugin）
│   ├── package.json
│   ├── index.ts               # Worker 入口
│   └── src/
│       ├── types.ts / config.ts / constants.ts / logger.ts
│       ├── cdp.ts             # CDP 客户端
│       ├── store.ts           # 会话状态（内存）
│       ├── llm.ts             # LLM 调用
│       ├── poller.ts          # DM 轮询主循环（依赖 Vencord dcBotPlugin）
│       └── server.ts          # HTTP API 服务器
├── skills/
│   └── discord-recruit/
│       └── SKILL.md           # 主动招新操作指南
└── AGENTS.md                  # 主 Agent 招新操作指南
```

## 安装步骤

### 1. 每台 bot 节点：启动 node-worker

在每台运行 Discord 账号的机器上：

**a. 安装并启动 OpenClaw（作为节点，管理 Chrome）**

```bash
openclaw config set browser.enabled true --json
openclaw config set browser.headless false --json
openclaw config set 'browser.profiles.openclaw.cdpPort' 18800 --json
```

**b. 登录 Discord**

```bash
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://discord.com/login
# 在打开的 Chrome 窗口中完成 Discord 登录
```

**c. 安装 Vencord 与 dcBotPlugin（前置条件）**

运行 Discord 的 Chrome 需安装 **Vencord Web** 并启用 **dcBotPlugin**，否则 node-worker 无法读取/发送 DM。从本仓库的 Vencord 工作区构建：`cd Vencord && pnpm buildWeb`，然后将 `dist/chromium-unpacked` 作为「加载已解压的扩展程序」加载，或在 UserScript 环境使用 `dist/Vencord.user.js`。在 Vencord 设置中启用 **dcBotPlugin**。

**d. 安装并启动 node-worker**

```bash
cd dc-bot-plugin/node-worker
npm install

# 按需设置环境变量（最少只需 LLM_BASE_URL）
export LLM_BASE_URL="http://192.168.8.201:8080/v1"
export LLM_MODEL="qwen2.5-7b"
export WORKER_PORT=3000
export CDP_PORT=18800

npm start
# 或: npx tsx index.ts
```

启动后应看到：

```
[INFO]  [worker] Gami node worker starting — CDP=127.0.0.1:18800  HTTP=:3000
[INFO]  [poller] Starting poller — CDP=127.0.0.1:18800, poll every 5000ms
[INFO]  [server] Worker HTTP server listening on :3000
```

**node-worker 环境变量一览：**

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `WORKER_PORT` | `3000` | worker HTTP 监听端口 |
| `CDP_PORT` | `18800` | Chrome CDP 端口（OpenClaw 管理的 Chrome）|
| `LLM_BASE_URL` | `http://192.168.8.201:8080/v1` | LLM API 地址 |
| `LLM_MODEL` | `default` | LLM 模型名 |
| `LLM_API_KEY` | `not-required` | LLM API Key |
| `POLL_INTERVAL_MS` | `5000` | 轮询间隔（毫秒）|
| `MAX_DM_TURNS` | `5` | AI 最多自动回复几轮 |
| `TAKEOVER_MESSAGE` | 内置中文通知 | 移交时发给用户的提示语 |
| `SYSTEM_PROMPT` | 内置 Gami 招新 Prompt | 对话系统 Prompt |

> **安全说明：** node-worker HTTP 接口只需在内网可达 gateway 即可，无需公网暴露。CDP 端口始终只绑定 `127.0.0.1`，不对外开放。

### 2. 在主节点配置插件

```bash
openclaw config set 'plugins.load.paths' '["/path/to/dc-bot-plugin"]' --json
openclaw config set 'plugins.entries.gami-discord-recruit.enabled' true --json
```

编辑 `~/.openclaw/openclaw.json`，填写各 bot 节点的 worker 地址：

```json5
{
  plugins: {
    entries: {
      "gami-discord-recruit": {
        config: {
          // 多 bot 模式：每个 bot 指向其 node-worker 的 HTTP 地址
          bots: [
            { id: "bot-local",  label: "本地机器人", workerUrl: "http://127.0.0.1:3000" },
            { id: "bot-node2",  label: "节点2机器人", workerUrl: "http://192.168.8.100:3000" },
            { id: "bot-node3",  label: "节点3机器人", workerUrl: "http://192.168.8.101:3000" },
          ]
        }
      }
    }
  }
}
```

单 bot 模式（不配置 `bots` 数组）：

```json5
{
  plugins: {
    entries: {
      "gami-discord-recruit": {
        config: {
          workerUrl: "http://127.0.0.1:3000"
        }
      }
    }
  }
}
```

### 3. 重启 Gateway

```bash
openclaw gateway restart
```

启动日志中应看到：

```
[gami-discord] Plugin started — 3 bot(s) configured
[gami-discord]   bot-local (本地机器人) → http://127.0.0.1:3000
[gami-discord]   bot-node2 (节点2机器人) → http://192.168.8.100:3000
[gami-discord]   bot-node3 (节点3机器人) → http://192.168.8.101:3000
```

## 使用方法

### 查看所有机器人状态

```
列出所有 Discord 机器人的状态
```

调用 `discord_bots_list` 工具，返回每个 bot 的 worker 地址、是否运行中、活跃对话列表。

### 自动 DM 对话

无需操作。每个 bot 节点的 node-worker 自动轮询 Discord，检测未读 DM 后：

1. 调用 LLM 生成回复
2. 通过 CDP 发送到 Discord
3. 前 N 轮（默认5轮）AI 自动处理
4. 超过轮数后发送接管通知并停止

### 主动招新（由 Gateway AI 控制 node 端浏览器）

招新**不由** `discord_recruit` 工具执行，而是由 **Gateway AI** 通过 OpenClaw 的 **node 端 browser 工具**（navigate、snapshot、act）完成。

1. 用 `discord_bots_list` 确认目标 bot 及其对应的 node（运行该 bot 的机器）。
2. 使用 **browser 工具**并指定该 node 为操作目标，然后：
   - 导航到 `https://discord.com/channels/{GUILD_ID}/{CHANNEL_ID}`
   - 打开成员列表，找到在线/空闲用户
   - 逐个点击用户 → 打开 DM → 输入招新话术并发送
3. 详细步骤与反检测要求见 `skills/discord-recruit/SKILL.md`。

**注意**：两条 DM 之间建议间隔 15–45 秒，每小时不超过 10 条。

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

### Plugin 配置（openclaw.json）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `workerUrl` | `http://127.0.0.1:3000` | 单 bot 模式或未配置 bots 时的默认 worker URL |
| `bots[].id` | — | 唯一 bot 标识，工具调用时使用 |
| `bots[].label` | 同 id | 友好名称，用于日志显示 |
| `bots[].workerUrl` | 继承全局 | 此 bot 对应 node-worker 的 HTTP 地址 |

### node-worker 配置（环境变量）

见 [安装步骤 → 1d](#1-每台-bot-节点启动-node-worker) 的环境变量表格。

## node-worker HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/status` | 运行状态 + 活跃会话列表 |
| `GET` | `/dms/:channelId` | 查询某频道的轮次状态 |
| `DELETE` | `/dms/:channelId` | 重置某频道的对话轮次 |

## 注意事项

- **Chrome 登录保持**：Session 过期后需在对应 bot 节点重新登录 Discord
- **安全**：node-worker HTTP 端口建议通过内网或 VPN 访问，不要暴露到公网
- **会话状态**：存储在 node-worker 内存中，worker 重启后重置
- **Vencord 前置**：未安装或未启用 dcBotPlugin 时，poller 会打 log 并跳过；需在浏览器中安装 Vencord Web 并启用 dcBotPlugin
- **并发保护**：同一频道不会并发处理，不同频道并行处理
