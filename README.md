# AgentDesk

本机执行、云端管控的 Agent 运行平台。第一个落地场景：**座舱媒体 Agent**。

> 状态：Week 1 完成（真实模型已接通、6 个文件/Shell 工具可用），并在 `deepseek-chat` 上拿到首个 live baseline。下一步见 `docs/roadmap.md`。

## 为什么不是"又一个 AI 聊天框"

- **Runtime 场景无关**：`packages/runtime` 不认识"媒体"，只认识"工具"。换场景只换工具集。
- **高危操作走审批闸门**：工具声明 `risk`，`confirm` 级别的调用在没有人批准时**不执行**，回合以 `awaiting_approval` 停下。
- **契约先行**：三端共享 `packages/protocol` 里的 `AgentEvent`，加一个事件类型会让所有消费方编译报错——这是故意的。
- **评测离线可跑**：`fixtures/` 用脚本化模型驱动，不花一分钱就能验证 harness 的接线是否正确。

## 快速开始

```bash
pnpm install
pnpm verify                                # build + 100 tests + eval 5/5 + demo，全离线

pnpm demo                                  # 回放 media-01，打印完整事件流
pnpm eval                                  # 跑全部 5 条夹具（脚本化模型，离线）
pnpm test                                  # 100 个单元测试
pnpm build                                 # tsc 严格模式类型检查

# 接真实模型（任意 OpenAI 兼容端点）
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.deepseek.com/v1   # 可选
export OPENAI_MODEL=deepseek-chat                    # 可选

pnpm dev run "放周杰伦的晴天"                # 单轮；结束会打印 session id
pnpm dev chat                              # 多轮；每轮自动落盘
pnpm dev sessions                          # 列出已记录的会话
pnpm dev items <thread>                    # Thread/Turn/Item 投影
pnpm dev audit                             # 审计：工具、批准、token
pnpm dev replay runs/sessions/<id>.events.ndjson    # 回放事件流
pnpm dev eval --live                       # 用真实模型跑夹具，会花钱
pnpm ui --replay <thread>                  # 看板 → http://127.0.0.1:4780
```

**完整的运行与验证清单**（每一层的预期输出、排错表）：[docs/verify.md](./docs/verify.md)
# 以上都可加 --store sqlite，落 runs/sessions/sessions.db
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
  runtime/   agent loop、provider 抽象、审批闸门、压缩（结构性 + 摘要）
  store/     会话落盘：JSONL（默认，可 grep）+ SQLite（可查询），同一契约
  tools/     fs_* / shell_run + 媒体域 mock + 场景（media|coding = 工具集 + 策略）
  eval/      夹具执行器 + 指标表
fixtures/    评测用例（JSON）
runs/        会话与事件流（gitignored，跑一次生成一次）
docs/        ADR、harness 拆解问题清单、路线图
```

## 工具

| 工具 | 风险 | 说明 |
|---|---|---|
| `fs_read` | safe | 带行号读取，支持 offset/limit |
| `fs_write` | safe | 写文件，自动建目录 |
| `fs_patch` | safe | 精确片段替换；找不到或不唯一时**失败**而不是猜 |
| `fs_glob` | safe | `**` 跨层级，跳过 node_modules/.git |
| `fs_grep` | safe | 正则搜索，输出 `path:line: text` |
| `shell_run` | **confirm** | 平台 shell，超时强杀，输出截断 8KB |
| `search_media` 等 7 个 | safe/confirm | 媒体域 mock，`set_window` 为 confirm |

工具名必须匹配 `^[a-zA-Z0-9_-]{1,64}$` —— 这是 OpenAI / DeepSeek function calling 的硬约束，**点号会让请求直接 400**，模型一个 token 都没跑。所以是 `fs_read` 而不是 `fs.read`；`defineTool` 在定义时就校验，写错名字启动即崩，不会拖到发请求才暴露。

所有路径都被 `resolveInside` 限制在工作区内。`confirm` 级工具没有审批回调时**不执行**，回合以 `awaiting_approval` 结束。

## 真实模型 baseline

`deepseek-chat`（`https://api.deepseek.com/v1`），2026-10-23 口径：**token 数来自端点返回的 `usage`**，不是估算。

| case | result | steps | input+output tokens | calls |
|---|---|---|---|---|
| media-01 | PASS | 2 | 3177 | search_media > play |
| media-02 | PASS | 2 | 3276 | search_media > play |
| media-03 | PASS | 3 | 5665 | search_media > play > next |
| media-04 | PASS | 0 | 980 | — （`awaiting_approval`，工具未执行） |
| media-05 | PASS | 0 | 959 | — （域外请求，不调工具） |

**5/5**。三个口径必须一起看：

- 这个分数测的是「策略 + 工具 + loop + 模型」的组合，不是模型单体。同一个模型没有 [mediaSystemPrompt](./packages/tools/src/media.policy.ts) 时是 3/5——会列歌单而不播放，会自己在文本里问「要打开车窗吗」。
- **一次请求 ≈ 1k input tokens**（7 个媒体工具）。13 个工具全下发时是 1.7k、同一批判例总消耗 24k；工具子集之后这批是 14k（-42%）。
- 早期显示的 `in=46` 是按字符数估的，漏掉了 tools 和 system，差两个数量级——现在所有数字都来自端点的 `usage`。

## 会话与回放

真实调用会写两份记录（`runs/` 已 gitignore），存储有两种实现，同一个 `SessionStore` 契约：

```
runs/sessions/<thread>.jsonl          jsonl：header + 每条消息 + 每轮 usage（默认，可 grep）
runs/sessions/sessions.db             sqlite：sessions/messages/turns 三张表（--store sqlite）
runs/sessions/<thread>.events.ndjson  事件流：AgentEvent 逐条，可 replay
```

- **header 里存了当时的 system prompt**。策略改了以后续跑老会话，仍然用当时那份策略——否则就是换了个实验条件去比分数。
- **`--resume <thread>`** 接着上一轮跑；`chat` 里连续多轮共享同一个 thread。
- **崩溃安全**：NDJSON 逐行追加，坏行跳过并计数；SQLite 用事务边界保证一行一条记录。
- **上下文预算**：每次请求前做三级压缩——旧工具结果截断 → 旧的置为 `[elided]` → 整轮丢弃（保证 tool call 与 result 同生共死）。**历史本身不删**，磁盘上永远完整，只有发给模型的请求窗口会缩小。
- **`items <thread>`** 打印 Thread/Turn/Item 投影：一条带两个 tool call 的 assistant 消息会变成三条 item——这是 UI 要渲染的形状，从消息派生而不是另存一份。

## 上下文压缩（实测）

`--summarize` 打开语义压缩：请求超过阈值时，把旧轮次交给模型总结成一段，替换请求里的旧历史。
摘要**持久化在会话里**（JSONL 的 `summary` 行 / SQLite 的 `summaries` 表），下一轮直接复用。

一次真实实验（80 条消息的长会话，`deepseek-chat`，同一 thread 连续三轮）：

| 步骤 | 请求 input tokens | 说明 |
|---|---|---|
| 无摘要 | 21,062 | 每轮都重发 80 条消息 |
| 首次摘要 | 21,668 | 含一次摘要请求（19k）+ 压缩后的主请求（2.5k） |
| 摘要后下一轮 | **1,249** | 复用已存摘要，不再重算 |

80 条消息被压成 117 tokens 的摘要，保留最近 10 条。**回本点在第一轮**：多花 0.6k 换后续每轮省 19.8k。

压缩触发用的是估算 token，所以估算器必须靠谱：`字符数/4` 在中文上低估约 3 倍（估 7.3k、实际 21k），已改成 CJK 按字符计权（~0.65 token/字）。这个 bug 是量出来的，不是想出来的。

## 审批、工作区与审计

**延迟审批（不是重跑）**：`confirm` 级工具让回合停在 `awaiting_approval`，宿主决定后用 `resume: { callId, decision }` 从**原地**继续同一个 turn。批准执行原调用；拒绝把错误回灌给模型。

```
$ pnpm dev run "把车窗打开"            # 非 TTY，默认拒绝
  ⏸ approval required set_window {"action":"open"}
  ⏹ awaiting_approval
  no TTY to ask — denying set_window (pass --yes to allow)
  ✗ denied set_window
  assistant 车窗没有打开，因为确认被拒绝了；如果你需要，我可以再试一次。
  ⏹ completed

$ pnpm dev run "把车窗打开" --yes      # 批准
  ⏸ approval required set_window {"action":"open"}
  ✓ approved set_window
  → tool set_window {"action":"open"}
  assistant 正在为你打开车窗。
```

**worktree 隔离**：`--worktree` 给会话开一个 git worktree（`runs/worktrees/<thread>`），文件工具只能落在里面。

```
$ pnpm dev run "在仓库根目录新建 notes.md，内容写 hello world" --scenario coding --worktree
  → tool fs_write {"path":"notes.md","content":"hello world\n"}
  workspace   ...\runs\worktrees\thread_96327a49-...
```

实测：worktree 里有 `notes.md`，用户 checkout 里没有。`resolveInside` 仍保留（第一道闸），但真正的隔离来自操作系统视图。

**审计**：`runs/audit.ndjson` 一人一行——谁、哪个工作区、什么工具、风险级、批准还是拒绝、耗时、每轮 token。

```
$ pnpm dev audit
time      thread        kind      what        decision  cost
12:57:37  5b47b149-534  approval  set_window  denied
12:57:38  5b47b149-534  turn      completed             1951/49
12:57:27  96327a49-fd8  tool      fs_write    ok        2ms
```

## 宿主与看板

```bash
pnpm ui                            # 启动宿主（默认 http://127.0.0.1:4780，带 token）
pnpm ui --replay <thread>          # 回放一段录好的事件流
pnpm ui --run "把车窗打开"          # 宿主跑一轮，审批在看板里点
pnpm ui --store sqlite             # 读 SQLite 会话
pnpm ui --no-auth                  # 关掉 token（本机自用）
```

```
view（浏览器 / CEF / Electron renderer）
   ├── GET  /events?since=N   SSE：带序号的事件流，断线重连只补缺口
   └── POST /api/rpc          bridge 契约：只有注册过的方法可达
host（Node 今天；Electron main / native 明天）
   └── store · broker · handlers
```

四条约束写在代码里，不是写在文档里：

- **view 只消费 `AgentEvent`**，不认识 provider、工具或磁盘。
- **特权操作全走 bridge**：未注册的方法直接被拒，handler 抛错变成错误字符串（不跨边界抛异常），没人回应的调用会超时而不是挂死。
- **重连靠序号**：`EventSource` 自动带 `Last-Event-ID`，宿主用 `since` 精确补发；如果请求的区间已被缓冲区淘汰，会写一条 `: gap after N` 注释而不是假装完整。
- **本机不是边界**：`/events` 和 `/api/rpc` 要 token（终端打印），静态文件与 `/health` 公开。token 走 `Authorization: Bearer` 或 `?token=`（`EventSource` 不能设 header）。

**看板能做的唯一写操作是「决定一个已经停下的审批」**：宿主用 `--run` 启动一轮，遇到 `confirm` 工具就停在 `awaiting_approval`；看板出现「批准 / 拒绝」按钮，点了走 `turn.resolve`，宿主用 Week 4 的 `resume { callId, decision }` **原地继续同一个 turn**。视图不能提交任务。

**流式**：`--run` 走 provider 的 `stream()`，`message.delta` 逐字进 SSE，看板是打字机效果。实测一次「把车窗打开（拒绝）」产生 **10 个 delta 帧**，最终 `message.complete` 与 `turn.end` 正常。

实测（Week 6 冒烟，`pnpm ui --run "把车窗打开"`）：

```
rpc 无 token        401
SSE 无 token        401
rpc 带 token        200
启动时 parked       set_window {"action":"open"}
点「拒绝」后事件     tool.approval_resolved → 10×message.delta → message.complete → turn.end completed
pending 清空        null
```

**为什么还没装 Electron**：这台机器上没法验证 GUI（也没法在 CI 里截图），Electron 的二进制下载还会把「跑不起来」的风险引进主线。宿主与视图的契约、事件流、bridge、HMI 都与容器无关——`packages/bridge` 已经提供**通道型传输**（`createHostTransport` / `createViewTransport`，就是 `ipcRenderer`、WebView2 `postMessage`、CEF 消息路由的形状），换容器只需要在两侧各接一次通道。

## 待办（Week 7）

Week 6 已完成：

- [x] 流式输出：`ModelProvider.stream?`，SSE 分片重组（文本 delta + 按 index 拼装 tool_calls），不重试已展示的字节
- [x] 宿主 token 鉴权：`/events` 与 `/api/rpc` 401，静态资源与 `/health` 公开
- [x] 审批 UI：看板按钮 → `turn.resolve` → 原地 `resume`，不是重跑
- [x] 通道型 bridge 传输（Electron / WebView2 / CEF 的接入形状）+ 测试
- [x] `--run "<task>"`：宿主内跑一轮并parked，方便演示与手测

Week 7 开始（度量与回归）：

- [ ] eval 回归：同样的 5 条用例可重复跑，记录历史（现在是一次性手跑）
- [ ] 成本/延迟/成功率三张表，接看板
- [ ] worktree GC 策略
- [ ] 压缩前后对比进 eval（成功率是否下降）

## 设计文档

- [项目上下文（新人/新会话先读这个）](./docs/CONTEXT.md)
- [ADR-001 架构与分层](./docs/adr-001-architecture.md)
- [读 harness 时要回答的 6 个问题](./docs/harness-questions.md)
