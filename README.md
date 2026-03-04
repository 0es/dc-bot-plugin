# Gami Discord Recruitment Plugin

OpenClaw 插件，为 Gami 游戏陪玩平台提供 Discord 招新能力。

## 功能

| 功能 | 实现方式 |
|------|---------|
| Discord 群组招新扫描 | 通过 OpenClaw 管理的浏览器访问 discord.com，规避 bot 检测 |
| 浏览器端访问 Discord | 使用 OpenClaw 内置 `browser` 工具操作真实 Chrome 浏览器 |
| 私聊独立 LLM 端点 | 通过多 Agent 路由，DM 对话使用 `http://192.168.8.201:8080/v1` |
| 自定义 system prompt | `AGENTS.md` 预置 Gami 招新助理角色和话术 |
| 5 轮后人工接管 | 双重保障：`discord_dm_gate` 工具 + `message:received` Hook |

## 文件结构

```
dc-bot-plugin/
├── openclaw.plugin.json     # 插件清单（必须）
├── package.json             # npm 包定义
├── index.ts                 # 插件主逻辑
├── skills/
│   └── discord-recruit/
│       └── SKILL.md         # 浏览器招新操作指南（AI 可读）
├── AGENTS.md                # discord-dm agent 的系统 Prompt
├── config-example.json5     # OpenClaw 配置示例（需合并到你的配置中）
└── README.md                # 本文件
```

## 安装步骤

### 前置要求

- OpenClaw 已安装并运行（Node 22+）
- Discord Bot 已创建并获得 Token（见 [Discord 配置](#discord-配置)）
- macOS + Chrome/Brave 浏览器（用于 Discord Web 访问）

### 1. 配置 Discord Bot

1. 前往 [Discord 开发者控制台](https://discord.com/developers/applications) 创建应用
2. 在 **Bot** 页面，开启以下 Privileged Gateway Intents：
   - **Message Content Intent**（必须）
   - **Server Members Intent**（推荐）
3. 点击 **Reset Token** 复制 Bot Token
4. 在 **OAuth2** 页面生成邀请链接，勾选 `bot` + `applications.commands`，并勾选以下权限：
   - View Channels / Send Messages / Read Message History / Embed Links
5. 用邀请链接将 Bot 加入你的服务器

### 2. 设置 Bot Token

```bash
openclaw config set channels.discord.token '"YOUR_BOT_TOKEN"' --json
openclaw config set channels.discord.enabled true --json
```

### 3. 合并插件配置

将 `config-example.json5` 中的各节内容合并到 `~/.openclaw/openclaw.json`：

```bash
# 查看当前配置
openclaw config show

# 设置插件路径
openclaw config set plugins.load.paths '["YOUR_ABSOLUTE_PATH/dc-bot-plugin"]' --json

# 启用插件
openclaw config set plugins.entries.gami-discord-recruit.enabled true --json
openclaw config set plugins.entries.gami-discord-recruit.config.maxDmTurns 5 --json
```

或直接编辑 `~/.openclaw/openclaw.json`，参考 `config-example.json5` 中注释说明。

**需要替换的占位符：**

| 占位符 | 说明 |
|--------|------|
| `<YOUR_LOCAL_MODEL_NAME>` | 本地 LLM 服务器提供的模型名称（如 `qwen2.5-7b`） |
| `<YOUR_GUILD_ID>` | Discord 服务器 ID（开启开发者模式后右键服务器图标复制） |

### 4. 为 discord-dm Agent 部署 AGENTS.md

```bash
mkdir -p ~/.openclaw/workspace-discord-dm
cp AGENTS.md ~/.openclaw/workspace-discord-dm/AGENTS.md
```

### 5. 添加多 Agent 路由

在 `~/.openclaw/openclaw.json` 中添加：

```json5
{
  agents: {
    list: [
      { id: "main", default: true, workspace: "~/.openclaw/workspace" },
      {
        id: "discord-dm",
        workspace: "~/.openclaw/workspace-discord-dm",
        model: "gami-local/<YOUR_LOCAL_MODEL_NAME>",
        tools: { allow: ["discord_dm_gate", "discord_dm_reset"] },
      },
    ],
  },
  bindings: [
    { agentId: "discord-dm", match: { channel: "discord", peer: { kind: "direct" } } },
    { agentId: "main", match: { channel: "discord" } },
  ],
}
```

### 6. 启用浏览器

```bash
openclaw config set browser.enabled true --json
openclaw config set browser.headless false --json
```

首次使用前，启动浏览器并手动登录 Discord：

```bash
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://discord.com/login
# 在打开的浏览器窗口中完成登录
```

### 7. 重启 Gateway

```bash
openclaw gateway restart
```

验证插件已加载：

```bash
openclaw plugins list
# 应看到 gami-discord-recruit 已启用
```

## 使用方法

### 触发 Discord 招新

在任意 OpenClaw 聊天界面（Telegram、Web Dashboard 等）向 Main Agent 发送：

```
帮我在 Discord 服务器 [GUILD_ID] 的 [CHANNEL_ID] 频道里找活跃用户并发送招新消息
```

Agent 将使用浏览器 Skill 导航到指定频道，收集活跃用户并逐一发送招新 DM。

### DM 对话流程

1. Discord 用户发来私信 → 路由到 `discord-dm` Agent
2. Agent 调用 `discord_dm_gate` 工具检查轮数
3. 前 5 轮：使用本地 LLM 正常回复，话术参考 `AGENTS.md`
4. 第 6 轮起：自动发送人工接管通知，停止 AI 回复

### 重置对话轮数

当人工客服完成跟进后，可重置某用户的对话计数器：

```
帮我重置 Discord 用户 [USER_ID] 的对话轮数
```

或直接调用 `discord_dm_reset` 工具。

## 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxDmTurns` | `5` | AI 最多回复几轮后移交人工 |
| `takeoverMessage` | 见 AGENTS.md | 移交时发送给用户的提示语 |

修改配置后需重启 Gateway：

```bash
openclaw config set 'plugins.entries.gami-discord-recruit.config.maxDmTurns' 3 --json
openclaw gateway restart
```

## 注意事项

- **浏览器登录**：每次重启 OpenClaw 后，如果浏览器 Session 过期，需要重新登录 Discord
- **招新频率限制**：Skill 指南中建议每小时不超过 10 条 DM，避免账号被限制
- **CAPTCHA**：如遇验证码，需人工介入处理，机器人无法自动通过
- **轮数计数**：当前轮数存储在内存中，重启 Gateway 后会重置；如需持久化，可扩展 `index.ts` 使用文件存储
