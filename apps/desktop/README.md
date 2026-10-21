# apps/desktop（Week 5 起）

Electron 宿主：主进程托管 `packages/runtime`，渲染进程通过 IPC 订阅 `AgentEvent`。

要点：
- runtime 必须能在没有 Electron 的环境里跑（CLI 已经证明了这一点），这里只做宿主适配。
- 窗口 = 模拟车机 HMI；later 换成真实 CEF 容器时，只替换 bridge 层。
- 审批弹窗是这一层的第一优先级，不是最后。
