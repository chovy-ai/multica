# 对话流视觉校准

本轮按 Multica 现有 UI 规范校准桌面对话流，保留会话列表与内容两栏、独立聊天入口、右下角 Agent / 模型选择和既有执行协议。参考当前代码中的 `packages/ui/styles/tokens.css`、按钮规范、原生聊天输入区，以及本轮实际捕获的桌面截图。

## 逐步检查与结果

| 步骤 | 本轮发现 | 调整后状态 |
| --- | --- | --- |
| 1. 阅读已有对话 | 输入框与底部操作区分离，正文、摘要和引用的视觉层级不一致 | 输入与底部操作合成一个表面，左右边距与消息对齐；正文使用 body，耗时使用 caption；引用使用 brand |
| 2. 打开 @ 智能体 | 少量结果仍占固定大面板，名称与说明挤在同一行；平面分类却显示目录导航提示 | 面板随内容收缩、结果较多时滚动；名称与说明分行，保留真实智能体头像；只显示适用的快捷键 |
| 3. 输入长草稿 | 面板位置原来测量收起的输入外壳，展开草稿时出现约 49px 重叠；低窗口仍强制预留 280px | 改用实际输入区域测量并观察其尺寸，面板向上展开且受可用视口高度约束 |
| 4. 新建会话首页 | 个人头像被同时传给唱片封面和首页两侧图标 | 恢复源 GUI 的运行器图标及内置唱片封面，@ 目录、消息引用与会话身份仍使用各自头像 |

这是一轮宿主展示适配，不改执行架构、后端、接口、数据库、Agent 权限或模型选择行为。Claude Code 未被调用。

## 状态流和修复边界

`Multica agents / sessions → parent-service descriptor → host application → GUI directory / mention service → 原有选择、发送与结果流`。

头像错误的第一个位置是宿主目录把 `iconUrl` 同时传作 `heroImageUrl`。移除该覆盖后，唱片使用源 GUI 的运行器封面；首页的 avatar projection 单独取运行器图标，不影响 @ 服务收到的个人头像。

面板重叠的第一个位置是 `useMentionPaletteFrame` 使用收起外壳的矩形，而输入区域会向上扩展。采用实际 prompt 区域作为锚点，保留原 portal、键盘选择、目录查询和发送逻辑。兼容性方案可以仅缩小固定面板，但不能解决长草稿与低窗口重叠，因此采用内容适配和实际锚点测量。

宿主构建适配位于 `packages/tutti-agent-gui-host/vite.config.ts`。每个替换要求上游源码唯一匹配，漂移会中止构建；`vendor/tutti` 源码未修改。

## Multica 视觉映射

| GUI 元素 | 采用的 Multica 规范 |
| --- | --- |
| 输入区 | surface、surface-border、radius-lg、brand / ring 聚焦状态 |
| 用户消息 | surface-selected、foreground、radius-2xl、body 字号与行高 |
| 回复和耗时 | foreground / muted-foreground、body / caption |
| @ 面板 | surface-raised、menu-shadow、radius-lg；行选中使用 surface-selected |
| 智能体名称与说明 | label / caption，两行层级，24px 头像 |
| 引用和发送 | brand 引用颜色、原生聊天同款 ArrowUp 图标 |

样式限定在宿主的 `conversation-appearance.css`，沿用现有公共组件和 tokens，无新增视觉依赖或资源。首页保留原 GUI 装饰与交互。

## 本轮截图

基线与原生聊天参考均在本轮从开发桌面应用捕获，未使用历史截图替代：

- [调整前桌面](../../.tmp/conversation-visual-refinement/01-before-desktop.png)
- [调整前 @ 面板](../../.tmp/conversation-visual-refinement/02-before-mentions.png)
- [原生聊天参考](../../.tmp/conversation-visual-refinement/03-native-chat-reference.png)
- [调整后桌面](../../.tmp/conversation-visual-refinement/04-after-desktop.png)
- [浅色窄窗口面板](../../.tmp/conversation-visual-refinement/after-light-760x420-mentions.png)
- [深色面板](../../.tmp/conversation-visual-refinement/after-dark-1440x1000-mentions.png)
- [恢复后的首页](../../.tmp/conversation-visual-refinement/06-after-home.png)

截图均打开检查后接受。自动截图禁用 CSS 过渡，避免把分类下划线切换的中间帧误判为位置错误；测试同时验证活动分类与下划线左右位置一致。

## 验证

从仓库根目录运行：

```sh
pnpm --filter @multica/tutti-agent-gui-host test
pnpm --filter @multica/tutti-agent-gui-host typecheck
pnpm --filter @multica/tutti-agent-gui-host build
pnpm --filter @multica/desktop build
node vendor/tutti/sync.mjs --verify
pnpm exec eslint --config packages/core/eslint.config.mjs packages/tutti-agent-gui-host/src/application.tsx packages/tutti-agent-gui-host/vite.config.ts e2e/tutti-agent-gui.spec.ts e2e/tutti-agent-mentions.spec.ts e2e/tutti-conversation-visual.spec.ts
make env-exec ARGS='-- pnpm exec playwright test e2e/tutti-agent-gui.spec.ts e2e/tutti-agent-mentions.spec.ts e2e/tutti-conversation-visual.spec.ts --trace retain-on-failure'
git diff --check
```

- 宿主 34 项测试、类型检查、宿主与桌面构建通过。
- 三套端到端测试合跑通过；首页恢复后重新运行完整对话流测试通过，最终视觉测试也通过。
- 视觉覆盖 light / dark，1440×1000、760×680、760×420、390×844，空查询、20 个结果滚动、键盘选择、14 行草稿、模型与 Agent 控件位置、活动分类下划线、减少动态效果，以及首页内置 Codex 唱片加载。
- 多智能体调用回归验证分别发送及当前会话显示各自结果；使用测试自有未连接运行器，不启动真实 CLI。
- 对话流回归包含模型记忆、引用、附件取消与重发、原生聊天保持独立。
- 上游校验：2,491 个源文件字节不变，22 个包 metadata overlay。
- 桌面构建存在已有 emoji-picker 同时静态 / 动态导入警告，不影响本轮构建。
- 宿主及 E2E 目录没有独立 ESLint 配置，显式使用仓库共享 React 配置检查，0 个错误；保留宿主既有两个 snapshot hook dependency 提示。

测试清理补齐了测试工作区清理，防止多个用例复用工作区时留下同名 Agent；冷启动 GUI 可见等待统一为 30 秒。未删除开发用户数据。

## 验证范围

本轮未调用真实模型，未验证安装包签名和分发。截图、键盘和几何回归不能替代完整读屏审计。桌面窗口连接在重启后一度中断，已捕获构建后开发环境的主界面；首页恢复、浅色与窄窗口以同份渲染代码的自动截图及几何断言为证据。
