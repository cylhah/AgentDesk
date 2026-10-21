# apps/gateway（Week 7 起）

Go + Gin：鉴权、审计、路由、成本统计、WebSocket 事件中继。

选择 Go 的理由：
- 并发与长连接是它的强项；
- 目标岗位（Tesla AI Agent 全栈）明确要求 Go；
- 与 TS runtime 形成清晰的语言边界：**Go 管"谁能做什么"，TS 管"怎么做"**。

审计表先设计好再写代码：`(id, actor, thread_id, turn_id, tool, args_digest, approved_by, ts)`。
