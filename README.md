# AgentDesk

本机执行、云端管控的 Agent 运行平台。第一个落地场景：**座舱媒体 Agent**。

> 状态：Week 1 完成（真实模型已接通、6 个文件/Shell 工具可用）。下一步见 `docs/roadmap.md`。

## 为什么不是"又一个 AI 聊天框"

- **Runtime 场景无关**：`packages/runtime` 不认识"媒体"，只认识"工具"。换场景只换工具集。
- **高危操作走审批闸门**：工具声明 `risk`，`confirm` 级别的调用在没有人批准时**不执行**，回合以 `awaiting_approval` 停下。
- **契约先行**：三端共享 `packages/protocol` 里的 `AgentEvent`，加一个事件类型会让所有消费方编译报错——这是故意的。
- **评测离线可跑**：`fixtures/` 用脚本化模型驱动，不花一分钱就能验证 harness 的接线是否正确。

## 快速开始

```bash
pnpm install

pnpm demo                                  # 回放 media-01，打印完整事件流
pnpm eval                                  # 跑全部 5 条夹具（脚本化模型，离线）
pnpm test                                  # 25 个单元测试
pnpm build                                 # tsc 严格模式类型检查

# 接真实模型（任意 OpenAI 兼容端点）
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.deepseek.com/v1   # 可选
export OPENAI_MODEL=deepseek-chat                    # 可选
pnpm dev run "放周杰伦的晴天"
pnpm dev eval --live                                 # 用真实模型跑夹具，会花钱
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

## 工具

| 工具 | 风险 | 说明 |
|---|---|---|
| `fs.read` | safe | 带行号读取，支持 offset/limit |
| `fs.write` | safe | 写文件，自动建目录 |
| `fs.patch` | safe | 精确片段替换；找不到或不唯一时**失败**而不是猜 |
| `fs.glob` | safe | `**` 跨层级，跳过 node_modules/.git |
| `fs.grep` | safe | 正则搜索，输出 `path:line: text` |
| `shell.run` | **confirm** | 平台 shell，超时强杀，输出截断 8KB |
| `search_media` 等 7 个 | safe/confirm | 媒体域 mock，`set_window` 为 confirm |

所有路径都被 `resolveInside` 限制在工作区内。`confirm` 级工具没有审批回调时**不执行**，回合以 `awaiting_approval` 结束。

## 待办（Week 2）

- [ ] 会话 JSONL 落盘 + `resume`
- [ ] 工具结果压缩 + 上下文预算初版
- [ ] 事件 NDJSON 输出，可回放
- [ ] 流式输出（现在是非流式，UI 阶段再补）

## 设计文档

- [项目上下文（新人/新会话先读这个）](./docs/CONTEXT.md)
- [ADR-001 架构与分层](./docs/adr-001-architecture.md)
- [读 harness 时要回答的 6 个问题](./docs/harness-questions.md)
