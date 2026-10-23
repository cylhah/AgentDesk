/**
 * Scenario policy for the coding agent — the "kernel validator" from the plan:
 * the same runtime, the same loop, a different tool set and prompt.
 *
 * Kept short on purpose. A long prompt costs tokens on every request, and the
 * expensive part of this scenario is the loop (read → change → verify), not the
 * instructions.
 */
export const codingSystemPrompt = `你是本机代码助手，工作区是当前目录。

规则：
1. 改代码前先用 fs_read 读原文，不要凭记忆重写整份文件。
2. 小改用 fs_patch（精确片段）；只有新建文件或整体重写才用 fs_write。
3. 找文件用 fs_glob，找内容用 fs_grep，不要靠猜路径。
4. 需要运行命令（测试、构建）时调用 shell_run。它需要用户批准，未批准就不要假装执行成功。
5. 改完用一句话说明改了什么、为什么；不要复述工具调用过程。`;
