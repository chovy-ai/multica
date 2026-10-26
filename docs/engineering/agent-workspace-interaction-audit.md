# Agent 工作台交互审查

本轮目标是让工作台沿用 Multica 的使用习惯：用户进入正在进行的会话、选择智能体、扫描会话和运行结果时，不需要理解第二套导航与状态规则。以本地 Electron 桌面为人工审查入口，原生聊天列表、Agent 管理与运行活动列表为对照。

## 审查步骤与证据

截图目录为本地 `.tmp/agent-workspace-ux-audit/`，不包含模型账号或登录凭据。

| 步骤 | 用户操作 | 初始结果与证据 | 优化目标 |
| --- | --- | --- | --- |
| 1 | 从原生聊天进入工作台 | 入口只带 `view=workbench`，URL 同步清除当前会话；原生对照截图 `01-native-chat.png` 与工作台 `02-workbench-directory.png` | 保留 `session`，视图切换不改变用户正在看的会话 |
| 2 | 查看会话后点击同一智能体 | 复现回到新草稿，截图 `03-agent-selection-resets-chat.png`；Agent 行直接调用新会话控制器 | 选择智能体负责筛选与查看历史，显式加号负责新建 |
| 3 | 查找与扫描会话 | 原生列表有时间、摘要、运行/失败及未读反馈；工作台仅有标题和智能体，截图 1、2 | 搜索覆盖会话标题与智能体；补齐主要状态、清楚呈现筛选和会话操作 |
| 4 | 查看任务与运行记录 | 运行以短 UUID、通用链接和内部目录为主，截图 `04-runs-before.png` | 以会话/任务名称、时间、耗时和结果说明为主，保留精确关联 |
| 5 | 调整桌面内容区宽度 | 代码证据：641–960px 目录始终可见，却提供三个互斥面板选项；追加页失败还会走整体错误分支隐藏现有数据 | 中宽只切会话/任务，窄宽再提供目录；失败后保留已加载列表并就地重试 |

保留的优点：工作台与主应用共用身份、权限、会话输入器、消息渲染、业务任务与运行状态；任务引用插入用户草稿，由用户确认发送。

## 根因与方案

问题集中在新增布局层的意图映射和信息投影。后端 API、WebSocket 和执行控制器已经提供所需数据，但布局把“选择”接成“新建”，视图入口省略现有会话，列表未呈现已有状态，响应式控件也没有表达实际可见区域。

采用沿用 Multica 状态所有者的方案：使用现有路径生成器和控制器处理导航；会话操作沿用既有 mutation；读取既有会话/运行数据展示用户可识别的信息；在工作台模块内修正布局与错误分支。保持 API 路径、字段、鉴权、状态和事件协议不变。

兼容方案是只添加提示文案解释这些差异，但会保留意外新建和上下文丢失，因此没有采用。没有为本轮重新设计全局路由、标签页或第二套执行引擎。

## 实现与验证

工程实现分别负责目录会话、任务运行面板和响应式布局，主线程负责导航接线、翻译、统一代码审查与原生桌面验收。新增基础控件使用 `@nextop-os/ui-system` 公开入口，沿用已经安装的依赖与公开 `styles.css`，复用 Multica 的业务头像、状态与时间格式。

本轮完成以下调整：

- 原生聊天的工作台入口保留当前会话。点击同一智能体保留会话及草稿，切换智能体打开最近活跃会话；新建按钮单独处理新草稿并退出归档筛选。
- 搜索匹配会话标题、智能体名称和项目已有的拼音规则；目录明确显示当前筛选，允许回到全部会话。
- 会话行补充最近时间、消息摘要、执行/等待/失败状态和未读数；提供置顶、归档、取消归档菜单。菜单与选择按钮分开，支持键盘打开、Escape 关闭并恢复焦点。
- 运行行显示业务来源、任务标识或会话名称、相对时间、耗时、取消人与失败原因。内部 UUID 只用于诊断提示，目录不再占据默认内容。
- 分页和刷新失败保留已加载内容，重试相应请求；加载更多有忙碌反馈，重叠页按实体 ID 去重。不能引用任务时提供可键盘访问的原因。
- 中等内容宽度保留目录，仅切换会话/任务；窄宽提供三个面板，并在从窄宽放大时修正面板选中状态。菜单 Portal 沿用 Multica 主题 token。

验证命令及结果：

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter @multica/views exec vitest run agent-workspace chat/chat-page.test.tsx chat/components/chat-input.test.tsx chat/components/chat-input-draft-isolation.test.tsx agents/agents-i18n-parity.test.ts` | 7 个文件、125 项通过；包括关键行为的失败复现及修复回归 |
| `make env-exec ARGS='-- pnpm exec playwright test e2e/agent-workspace.spec.ts'` | 1 项通过，10.8 秒；覆盖 1440/900/390px、跨断点、会话与草稿保留、菜单和面板键盘操作，以及原有发送/取消/恢复流程；测试 Runtime 不调用真实模型 |
| `pnpm --filter @multica/views typecheck`、`pnpm --filter @multica/desktop typecheck` | 通过，包含桌面 main/preload/renderer |
| `pnpm --filter @multica/views exec eslint agent-workspace chat/chat-page.tsx chat/chat-page.test.tsx`、`git diff --check` | 通过 |
| `pnpm --filter @multica/desktop exec electron-vite build` | 通过；既有 emoji-picker 导入警告保留 |
| 四语言 workbench 翻译键与插值检查 | en、zh-Hans、ja、ko 一致 |
| 原生 Electron 人工验收 | 重启后会话不丢失；点击当前智能体保留会话；Agent 名称搜索可用；菜单关闭后回焦；深浅主题菜单与运行信息清晰；原生后退/前进恢复同一会话 |

桌面开发服务在新增文件后保留了旧的解析失败缓存；通过托管命令仅重启 desktop 组件后恢复。此项没有改动产品协议或开发服务配置。验收后恢复原来的“跟随系统”主题，停留在真实 Codex 会话与运行记录。

## 截图复核

以下均为本轮捕获并重新打开检查的原生 Electron 截图。新增菜单由 UI System 公开组件提供，自定义样式只用于 Multica 字号、主题和容器布局映射，没有新增依赖或全局重设计。

步骤 1–3，优化前的工作台目录：

![优化前目录](/Users/zhengweibin/Desktop/share-workspace/multica/.tmp/agent-workspace-ux-audit/02-workbench-directory.png)

步骤 2，优化前点击智能体导致当前会话变成新草稿：

![优化前意外新建](/Users/zhengweibin/Desktop/share-workspace/multica/.tmp/agent-workspace-ux-audit/03-agent-selection-resets-chat.png)

步骤 2–3，优化后点击同一智能体仍保留当前会话，同时显示筛选与摘要：

![优化后保留会话](/Users/zhengweibin/Desktop/share-workspace/multica/.tmp/agent-workspace-ux-audit/06-agent-selection-after.png)

步骤 3，优化后的会话操作菜单：

![深色会话菜单](/Users/zhengweibin/Desktop/share-workspace/multica/.tmp/agent-workspace-ux-audit/08-session-menu-after.png)

步骤 4，优化前的运行记录：

![优化前运行记录](/Users/zhengweibin/Desktop/share-workspace/multica/.tmp/agent-workspace-ux-audit/04-runs-before.png)

步骤 3–4，浅色主题下的菜单与运行记录：

![浅色优化结果](/Users/zhengweibin/Desktop/share-workspace/multica/.tmp/agent-workspace-ux-audit/11-light-menu-runs-after.png)

步骤 1–4，恢复跟随系统后的最终桌面状态：

![最终桌面状态](/Users/zhengweibin/Desktop/share-workspace/multica/.tmp/agent-workspace-ux-audit/12-desktop-final.png)

## 验证边界

截图可验证信息层级、对比与操作结果，不能单独证明完整可访问性。键盘交互、状态回归与错误恢复须结合组件及端到端测试。运行反馈的人工复核使用已有 Codex 验收记录，本轮不会为视觉审查重复消耗真实模型额度。

正式签名安装包、Windows/macOS 不同显示缩放、长时间运行及完整辅助技术测试不属于本轮已验证范围。
