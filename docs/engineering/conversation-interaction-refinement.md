# 对话流交互优化

本轮从现有 Multica 对话流走查，不改变两栏布局、首页图案、原生聊天、任务管理或 Agent 执行架构。参考 `ConversationFlowPage`、`TuttiAgentGuiPanel`、宿主适配和源 GUI 的引用控制器、公开聚焦能力，未新增依赖。

## 走查结果

| 步骤 | 调整前实际表现 | 调整后状态 |
| --- | --- | --- |
| 1. 连续 @ 多个智能体 | 第一个选好后，第二次输入 @ 会回到“会话”，需要再次切到“智能体” | 同一输入组件中记住最后使用的分类；连续输入、Escape 关闭后重开都保留选择，手动切换仍生效 |
| 2. 搜索或浏览归档时新建 | 创建成功但列表仍使用旧搜索或归档视图，新会话不可见，容易误以为未创建 | 仅在创建成功且用户选择意图仍有效时清除搜索、切回历史并显示当前新会话 |
| 3. 新建后直接输入 | 输入框可见但没有焦点，还要点一次；过早转交焦点又会被会话加载清掉 | 等目标会话加载后使用源 GUI 的公开聚焦请求；输入不可用或窗口不活跃时保留待处理请求 |

保留的行为：创建失败时保留搜索和旧草稿；晚到响应不替换用户的新选择；切回原会话时恢复原草稿；默认发送、模型选择、真实智能体身份和多智能体执行方式不变。

## 根因和状态流

引用面板：`AgentMentionSearchController.close()` 取消请求和清理查询时，同时把 `currentFilter` 设回默认值。现在仅保留分类，其余清理和过期请求防护不变。分类只在组件生命周期内有效，不新增全局偏好或持久化数据。

新建会话：原成功回调只切换 URL，没有处理列表的搜索和本地归档浏览状态。现在的状态流为：

`创建成功 → 检查当前工作区、路由和选择意图 → 清空筛选、重置列表浏览 → 切换新会话 → 目标会话加载 → 公开聚焦请求 → 可用的输入框`。

焦点请求有可见性和可用性约束。加载途中切换视图会取消旧的聚焦交接，不在隐藏窗口执行聚焦。没有加入固定等待时间，也没有直接操作源编辑器的私有状态。

## 方案取舍

| 问题 | 采用方案 | 未采用的兼容方案 |
| --- | --- | --- |
| 重复 @ | 保留用户上次选择的分类 | 固定默认成“智能体”，仍会打断连续引用任务或会话 |
| 新会话不可见 | 成功后恢复能显示新会话的列表状态 | 点击新建时立即清搜索，会在请求失败时丢失浏览上下文 |
| 输入焦点 | 按目标会话加载和输入可用状态交接 | 固定延迟或反复定时聚焦，会随网络速度变化并可能抢走后续焦点 |

## 修改边界

- `packages/views/tutti-agent-gui/conversation-flow-page.tsx`：创建成功后的列表状态与聚焦意图，保留晚到响应保护。
- `packages/views/tutti-agent-gui/tutti-agent-gui-panel.tsx`：转发聚焦意图，保持同一个 iframe 文档，保留后台写入限制。
- `packages/tutti-agent-gui-host/src/application.tsx`、`composer-footer-controls.tsx`：目标会话就绪后向源 GUI 交接聚焦请求。
- 内部初始化快照新增可选展示字段 `composerFocusSequence`。后端 API、请求字段、Agent 执行协议和数据库均未变更。
- `packages/tutti-agent-gui-host/vite.config.ts`：引用分类记忆与输入就绪保护使用唯一匹配的宿主构建适配，源代码漂移会中止构建。
- 上游 `vendor/tutti` 的 2,491 个源文件保持字节不变。

## 本轮截图

以下基线在本轮通过实际页面走查捕获；调整后由同份共享界面回归捕获，均保存后打开检查。

1. [首页基线](../../.tmp/conversation-interaction-refinement/01-before-home.png)
2. [第二次 @ 跳回会话](../../.tmp/conversation-interaction-refinement/02-before-repeat-mention.png)
3. [搜索中新建但列表不显示新会话](../../.tmp/conversation-interaction-refinement/03-before-new-session-search.png)
4. [新会话显示并获得输入焦点](../../.tmp/conversation-interaction-refinement/04-after-new-conversation.png)
5. [连续 @ 时保留智能体分类](../../.tmp/conversation-interaction-refinement/05-after-repeat-mention.png)
6. [重启后的桌面窗口](../../.tmp/conversation-interaction-refinement/06-desktop-after.png)
7. [中文实际页面：连续 @ 保留分类](../../.tmp/conversation-interaction-refinement/07-after-repeat-mention-zh.png)
8. [中文实际页面：新会话可见且光标已在输入框](../../.tmp/conversation-interaction-refinement/08-after-new-conversation-zh.png)

第 2 / 7、3 / 8 步分别以同一视口配对检查；实操后清除了未发送输入，将本轮新建的两个空会话归档，未发送模型请求。

## 验证入口

```sh
pnpm --filter @multica/views test tutti-agent-gui
pnpm --filter @multica/tutti-agent-gui-host test
pnpm --filter @multica/views typecheck
pnpm --filter @multica/tutti-agent-gui-host typecheck
pnpm --filter @multica/tutti-agent-gui-host build
pnpm --filter @multica/desktop build
make env-exec ARGS='-- pnpm exec playwright test e2e/tutti-agent-gui.spec.ts e2e/tutti-agent-mentions.spec.ts e2e/tutti-conversation-visual.spec.ts e2e/tutti-conversation-interactions.spec.ts --trace retain-on-failure'
node vendor/tutti/sync.mjs --verify
git diff --check
```

新增交互用例覆盖失败重试、搜索后新建、归档中新建、输入焦点、旧草稿、连续选择两个智能体、Escape 和分类切换；使用测试自有未连接运行器，并断言没有生成任何执行任务。

聚焦路径曾在回归中暴露加载时序问题，修正后不依赖截图或固定等待来通过聚焦断言，连续三轮回归通过。Views 36 项、宿主 34 项测试与类型检查通过。相关 ESLint 检查为零错误，保留三个既有 hook dependency 提示。桌面构建通过，存在已有 emoji-picker 分包和 highlight 样式构建提示。

四条 E2E 流程均有通过记录：新增交互、多智能体调用、深浅主题与窄窗口视觉、完整原流程。合跑首轮在原生 Chat 首次加载时超时，尚未进入本轮修改的对话流；未修改代码单独重跑原流程后通过（50.8 秒）。日志分别保存在 `.tmp/conversation-interaction-refinement/e2e-all.log`、`e2e-original-flow.log` 和 `e2e-interactions.log`。

## 验证范围

本轮未调用 Codex 或 Claude Code 真实模型。Mac 锁屏期间桌面工具不能操作窗口；用户解锁后已复核重启后的桌面截图，连续引用与新建聚焦的实操通过同源共享页面完成。截图和键盘检查不代表完整读屏审计，也未覆盖所有第三方输入法。
