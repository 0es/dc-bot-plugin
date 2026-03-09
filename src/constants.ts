// ── Global defaults ───────────────────────────────────────────────────────────

export const DEFAULTS = {
  maxDmTurns: 5,
  pollIntervalMs: 5000,
  cdpHost: "127.0.0.1",
  cdpPort: 18800,
  llmBaseUrl: "http://192.168.8.201:8080/v1",
  llmModel: "default",
  llmApiKey: "not-required",
  takeoverMessage:
    "感谢您的耐心交流！我们的人工客服将接管后续沟通，为您提供更专业的服务。请稍候，工作人员将很快与您联系。🎮",
} as const;

// ── Default system prompt ─────────────────────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPT = `你是 Gami 游戏陪玩平台的智能招募专员。

## 平台介绍
Gami 是专注游戏陪玩的平台，连接游戏玩家与专业陪玩师。
核心优势：灵活工作时间、公平分成机制、多游戏品类支持（LOL、王者荣耀、VALORANT等）、活跃社区。

## 对话规则
- 语气友好热情，像朋友间的对话
- 每条回复保持简洁（不超过150字），适度使用 emoji
- 聚焦招募话题，礼貌引导离题对话回正
- 不主动提供具体薪资数字（引导咨询人工客服）

## 常见问题参考
- 收入怎样？→ 引导联系人工客服了解详细分成
- 需要什么设备？→ 普通电脑 + 稳定网络即可
- 只会一款游戏行吗？→ 专精一款反而更受欢迎

## 加入条件
年满18岁、有游戏热情、擅长至少一款主流游戏、有良好沟通能力。`;

// ── Outbound recruitment message templates ────────────────────────────────────
// Rotated per-user to avoid sending identical messages in the same session.

export const RECRUIT_MESSAGE_TEMPLATES = [
  "嗨！👋 我是 Gami 平台的招募专员。\n\nGami 是游戏陪玩平台，正在招募热爱游戏的小伙伴加入陪玩团队。\n\n✨ 灵活接单 | 公平分成 | 活跃社区\n\n有兴趣了解的话欢迎回复我！🎮",
  "你好～ 我在帮 Gami 陪玩平台招募有游戏热情的小伙伴。\n\n平台灵活、收益透明，很适合喜欢游戏的玩家 😊\n\n感兴趣可以聊聊～",
  "嗨！在找喜欢游戏的小伙伴加入 Gami 陪玩团队～\n\n灵活接单，按时结算，多游戏品类都有 🎮\n\n有兴趣可以了解一下！",
] as const;

// ── Plugin entry ID ───────────────────────────────────────────────────────────

export const PLUGIN_ID = "gami-discord-recruit";
