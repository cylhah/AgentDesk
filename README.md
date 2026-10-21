# AgentDesk

本机执行、云端管控的 Agent 运行平台。第一个落地场景：**座舱媒体 Agent**。

> 状态：Week 0 完成（骨架 + 协议 + 评测夹具）。下一步见 `docs/roadmap.md`。

## 为什么不是"又一个 AI 聊天框"

- **Runtime 场景无关**：`packages/runtime` 不认识"媒体"，只认识"工具"。换场景只换工具集。
- **高危操作走审批闸门**：工具声明 `risk`，`confirm` 级别的调用在没有人批准时**不执行**，回合以 `awaiting_approval` 停下。
- **契约先行**：三端共享 `packages/protocol` 里的 `AgentEvent`，加一个事件类型会让所有消费方编译报错——这是故意的。
- **评测离线可跑**：`fixtures/` 用脚本化模型驱动，不花一分钱就能验证 harness 的接线是否正确。

## 快速开始

```bash
pnpm install

pnpm demo     # 把 media-01 跑一遍，打印完整事件流
pnpm eval     # 跑全部 5 条夹具，输出通过率表
pnpm test     # 单元测试
pnpm build    # tsc 类型检查（严格模式）
```

预期输出（demo，节选）：

```
case media-01 — 单轮明确意图：放周杰伦的晴天

user 放周杰伦的晴天

▶ turn turn_...
  → tool search_media {"query":"晴天","artist":"周杰伦"}
  ✓ [{"id":"t-001","title":"晴天","artist":"周杰伦"}]
  → tool play {"trackId":"t-001"}
  ✓ {"nowPlaying":"晴天","artist":"周杰伦"}
  assistant 正在为你播放周杰伦的《晴天》。
  usage: in=... out=...
  ⏹ completed
```

## 结构

```
apps/
  cli/       当前唯一宿主：跑 demo / eval（Week 5 起补 desktop / web / gateway）
packages/
  protocol/  事件、消息、工具契约（zod）
  runtime/   agent loop、provider 抽象、审批闸门
  tools/     fs.read（已实现）+ 媒体域 mock
  eval/      夹具执行器 + 指标表
fixtures/    评测用例（JSON）
docs/        ADR、harness 拆解问题清单、路线图
```

## 待办（Week 1）

- [ ] `fs.write` / `fs.patch`（D2）
- [ ] `shell.run`（超时 + 输出截断）（D3）
- [ ] `fs.glob` / `fs.grep`（D3）
- [ ] 真实 provider（OpenAI 兼容协议，流式 + tool calling）（D1）
- [ ] `zodToJsonSchema` 换成真正的转换器（当前是降级实现）

## 设计文档

- [ADR-001 架构与分层](./docs/adr-001-architecture.md)
- [读 harness 时要回答的 6 个问题](./docs/harness-questions.md)
