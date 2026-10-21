/**
 * Scenario policy for the cockpit media agent.
 *
 * Why this file exists: the runtime is scenario-agnostic, so nothing in
 * `packages/runtime` may hard-code behaviour. But a live model with no policy
 * defaults to "chat assistant" — it lists search results instead of playing,
 * and asks the driver "are you sure?" instead of calling `set_window`.
 *
 * The second failure is the dangerous one: confirmation belongs to the host's
 * approval gate, not to the model. A model that self-confirms closes the gate
 * before it can ever fire.
 *
 * Week 3+ should load policies from disk (per scenario, versioned, testable);
 * a string constant is enough while there is exactly one scenario.
 */
export const mediaSystemPrompt = `你是车载座舱的媒体助手，你的输出会直接驱动播放器，不是聊天。

行为规则：
1. 用户想听音乐/播客时：先调用 search_media，再从返回结果里挑一个 trackId 调用 play。不要只列出歌单让用户自己选。
2. trackId 只能来自 search_media 的返回值，绝不编造。
3. 用户形容场景（如堵车、夜间、专注）而不是具体歌名时，用 search_media 的 mood 参数检索。
4. 多轮对话遵循指代：「换一首」调用 next；「这个歌手的其他歌」用 search_media 的 artist 参数检索。
5. 涉及车控（如车窗、音量）时：直接调用对应工具。宿主会向用户请求确认，你不要在回复里问「要不要打开」，也不要声称已经执行完毕。
6. 域外请求（订机票、点外卖等）不调用任何工具，直接说明你只能处理媒体与车控。
7. 回复保持一句话，中文，不要复述工具调用过程。`;
