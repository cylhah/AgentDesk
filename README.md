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
pnpm ui                            # 浏览器模式（默认 http://127.0.0.1:4780，带 token）
pnpm ui:electron                   # Electron 窗口（真容器，沙箱渲染进程）
pnpm ui:electron --run "把车窗打开"  # 起一轮，窗口里点批准/拒绝
pnpm ui --replay <thread>          # 回放一段录好的事件流
pnpm ui --store sqlite             # 读 SQLite 会话
pnpm ui --no-auth                  # 关掉 token（本机自用）
```

**Electron 外壳**（`apps/desktop/electron/`）：

- 主进程不重写宿主，而是用 `ELECTRON_RUN_AS_NODE=1` **把同一个 Node 宿主作为子进程拉起**，再开一个沙箱窗口指向它 —— 宿主代码零改动。
- 窗口 `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`：渲染进程拿不到 `fs`、`child_process`、会话存储。
- `preload.cjs` 只暴露两个方法：`info()`（版本/平台）和 `resolveApproval(decision)`（审批）。这就是「native 边界」在代码里的样子。
- 实测：窗口标题 `AgentDesk · 座舱媒体`；渲染进程通过 preload 调到主进程后写出 `runs/shell-bridge.log`（`preload bridge ok`）。

> **踩到的坑**：如果从另一个 Electron 应用（如 IDE/agent 宿主）里启动，环境会继承 `ELECTRON_RUN_AS_NODE=1`，此时 `electron` 二进制退化成纯 Node —— `require("electron")` 返回一个路径字符串、`app` 是 undefined。`launch.cjs` 会清掉这个变量再启动，并写了注释说明。

```
view（浏览器 / Electron renderer / CEF）
   ├── GET  /events?since=N   SSE：带序号的事件流，断线重连只补缺口
   └── POST /api/rpc          bridge 契约：只有注册过的方法可达
host（Node；由 Electron 主进程或终端拉起）
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

**为什么拖到 Week 6 才装**：这台机器上没法自动化验证 GUI，Electron 的二进制（~100MB）下载还会把「跑不起来」变成主线风险。所以先把容器无关的那层做完（契约、事件流、bridge、HMI），最后才接壳。真正的意外是网络：默认从 GitHub 下载失败（`fetch failed`），换 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 才装上——这一步值得记，换台机器照做即可。

## 度量与回归

```bash
pnpm eval --live --record                        # 跑 media 套件，落一份历史
pnpm eval --live --suite long --record           # 长历史套件（关键事实只在第一轮）
pnpm dev history                                 # 通过率 / 成本 / 延迟 / 条件
```

看板右上角「度量」读的是**同一份** `runs/eval-history.ndjson`——命令行和 GUI 不会出现两套数字，还带 token 与 p50 的趋势线。

### 长历史 A/B：压缩到底压掉了什么

`fixtures/long/long-01.json` 用 120 轮对话把"那个歌手 = 周杰伦"这条事实推到很远的地方，
最后一句是「再来一首刚才那个歌手的歌」。三组对照（`OPENAI_TEMPERATURE=0`，两次运行 token 完全一致）：

| 配置 | tokens | 结果 | 为什么 |
|---|---|---|---|
| 基线（不压缩） | 11,982 | PASS | 全量历史，模型能追到第一轮的约定 |
| 硬裁剪 `ctx=1200` | **5,131** | **FAIL** | 省 57% token，但把"那个歌手=周杰伦"裁掉了，模型只查了当前播放就反问 |
| 摘要 `--summarize-at 1200` | 7,190 | PASS | 省 40%，摘要保留了这条事实 |

**这就是"结构性压缩 vs 语义压缩"的真实差价**：硬裁剪更便宜，但它丢的是事实；摘要贵一点，但保住的是可推断性。

`OPENAI_TEMPERATURE=0` 不是可选装饰：不设时同一输入会一次调工具、一次只回文本（试过，两次 token 相同、结果相反）。
**回归的前提是可复现**，所以基线必须先把温度钉死。

### 两次失败的夹具迭代（也是结论）

1. **每轮都提周杰伦** → 硬裁剪后最近几轮仍带着事实，`ctx=1` 也 5/5，测不出差异。
2. **400 轮 + 事实只在第一轮** → 连基线都失败：模型直接反问"想听哪位"，与压缩无关。
3. **120 轮 + 显式约定（"以后我说那个歌手就是指周杰伦"）+ temp=0** → 基线稳定通过，裁剪稳定失败。

worktree 回收：

```bash
pnpm dev worktrees           # 列出每个会话的 worktree
pnpm dev worktrees --gc 7    # 删掉 7 天没动过的（只动 runs/worktrees/ 下的）
```

## 审批队列与便携打包

**一次步骤里的多个高危调用会一起停下**，不是一条一条来：

```
⏸ 待确认 2 项
  set_window {"action":"open"}     [批准] [拒绝]
  set_window {"action":"close"}    [批准] [拒绝]
  [提交 2 项决定]
```

宿主拒绝「部分提交」——没被决定的调用会以无结果的 tool_call 留在历史里。所以 UI 必须一次给全，
宿主用一次 `resume { decisions }` 全部结算（同一回合继续，不重跑）。默认每行是「批准」，改哪行点哪行。

**便携打包**：

```bash
pnpm package      # → dist/AgentDesk/（含 AgentDesk.cmd）
```

- 目录里是 `electron.exe` + `resources/app/`（打包后的 `host.mjs` 200KB + HMI + preload）。
- **双击 `AgentDesk.cmd`**，不要双击 `electron.exe`：如果从另一个 Electron 应用启动，会继承
  `ELECTRON_RUN_AS_NODE=1`，二进制退化成 Node，窗口不出现（这个坑在开发时已经踩过一次）。
- **首次运行**：在目录里建 `.env`（`OPENAI_API_KEY=…`、可选 `OPENAI_BASE_URL` / `OPENAI_MODEL`）。
  宿主启动时读取，已有环境变量优先。没配 key 时看板顶部会出现一条黄色提示，历史仍可浏览。
- **数据在本地**：`runs/` 就在 exe 旁边，整个文件夹拷走即带走会话与审计。
- 没有安装包、没有代码签名、没有自动更新——这是「能跑」和「能发行」之间的差距。

实测（打包版）：窗口标题 `AgentDesk · 座舱媒体`；`/health` 正常；`host.info` 显示
`providerConfigured: true`（读到了同目录的 `.env`），`store` 指向 `dist/AgentDesk/runs/sessions`。

## 待办（Week 10）

Week 9 已完成：

- [x] 多 pending 审批队列：一次步骤内全部 park，逐项选择 + 一次提交，宿主拒绝部分提交
- [x] 看板审批写审计（此前只有 CLI 写，宿主这条路径是漏的）
- [x] 便携打包 `pnpm package`：bundle 宿主（esbuild）、沙箱窗口、启动脚本、README
- [x] 首次运行：`.env` 支持 + 缺 key 提示条
- [x] 测试：119 passed

Week 10 开始：

- [ ] 安装包（NSIS / 代码签名）与自动更新
- [ ] worktree 与 dist 的清理策略（打包产物会累积）
- [ ] demo 视频脚本 + 3 篇文章提纲
- [ ] 简历 bullet 用真实数字回填（成功率 / 成本 / 延迟 / 裁剪对照）

## 设计文档

- [项目上下文（新人/新会话先读这个）](./docs/CONTEXT.md)
- [ADR-001 架构与分层](./docs/adr-001-architecture.md)
- [读 harness 时要回答的 6 个问题](./docs/harness-questions.md)
