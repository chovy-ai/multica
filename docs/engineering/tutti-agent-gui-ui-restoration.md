# 对话流 GUI 的 Multica 视觉对齐与验收

## 目标与不变边界

保留 Tutti `AgentGUI` 的完整布局、组件结构和交互，在独立 iframe 文档中消费 Multica 的字体与语义 token。此次对齐改变视觉呈现，不替换会话列表、时间线、编辑器、菜单、弹窗或其运行引擎。

独立入口仍为 `/{workspaceSlug}/conversations`，原聊天仍为 `/chat`，两者的会话选择和草稿相互独立。Task 导航、附件上传、发送绑定、取消恢复、身份映射、权限与错误处理继续遵守已有适配协议。没有新增后端能力；缺少真实服务支持的能力不能用空成功或伪造状态补齐。

本次采用 iframe 内的主题适配层：构建时从真实 `@multica/ui/styles/tokens.css` 生成 `.multica-tokens.css`，保留 token 值及 Tailwind 指令，仅将调色板的 `:root`、`.dark` 选择器增强为当前 iframe 根作用域，再将上游视觉变量映射到相应角色。没有复制一份自行维护的颜色表，也没有给整套源 CSS 统一套 layer；该 layer 方案因 Tailwind `@utility` 不能嵌套而放弃。组件级覆盖只补充字体层级、控件角色与 portal 范围，不改变源布局和测量。

零散写死每个控件的颜色或重写整套 GUI 是兼容替代方案，但会遗漏 portal、主题及语言分支，且扩大改动边界，因此未采用。

## 设计负责人、工程分工与退回机制

| 责任人 | 负责范围 | 交付与复核 |
| --- | --- | --- |
| 设计负责人 / root | 确认 Multica 参考页面、视觉规格、源布局保留范围；统一构建、桌面操作与截图 | 对照修复前后同主题、语言、尺寸截图和测量结果；最终验收签收 |
| 主题与字体工程 Agent | iframe 主题、真实字体资源、语义变量映射、`data-theme` 与 `.dark` 同步 | 提供映射依据、语言分支检查、类型检查结果；不得改父文档全局样式 |
| 组件样式工程 Agent | 会话行、菜单、按钮、输入和文本层级的局部视觉适配 | 使用实际源选择器与 Multica token；不得重写上游组件或改变原有测量常量 |
| 验收 Agent | 本文及 `e2e/tutti-agent-gui.spec.ts` | 明确基线、可执行断言与未覆盖项；本轮不自行构建、操作 UI 或执行 E2E |

每次工程交付先检查改动边界，再由 root 运行验证和查看真实桌面。若失败，向对应工程负责人退回具体状态、源选择器、期望 token、实际 computed style、视口与截图。修复须处理首个错误状态，不得通过隐藏控件、降低业务断言、修改协议、改造原聊天或缩减原 GUI 布局来通过验收。重测相关失败项后再由 root 签收；没有实际证据的项保持“待验”。

## 已批准的视觉规格

| 对象 | Multica 角色或约束 |
| --- | --- |
| 文档正文 | 真实 Inter 字体资源，保留桌面 CJK fallback；正文基础为 14px / 20px |
| 代码、终端和等宽内容 | 真实 Geist Mono 字体资源；不能仅声明一个不存在的字体名 |
| 聊天画布与正文 | `.agent-gui-node__detail-panel` 使用 `--page-canvas`，正文使用 `--foreground` |
| 完整布局基底 | `.agent-gui-node__layout` 使用 `--app-shell`；不能为了画布断言把整个 grid 基底改成聊天画布 |
| Agent rail 与会话侧栏 | `--app-shell`；次级文字使用 `--muted-foreground` |
| Hover 与选中 | `--surface-hover`、`--surface-selected`；hover 其他行不改变当前会话 |
| 浮层 | `--surface-raised`、`--surface-border`、`--menu-shadow`；portal 保持在 iframe 内 |
| 主题 | 浅色、深色的 `data-theme` 与 `.dark` 同步；父页面主题和样式不被源 CSS 污染 |
| 布局测量 | 保留源 provider rail 52px；dock 输入区最小高度 56px、编辑器行高 24px；不能通过整体缩放或硬改测量值进行视觉对齐 |

保留源的 rail 收起、拖宽、会话切换、菜单、键盘、时间线、上传和编辑器行为。字体与表面角色对齐不意味着将全部布局间距或组件高度替换成另一套数值。文档根字号继续保持原浏览器基准，避免改变所有 rem 布局尺寸。

## 编号审查步骤与结果

1. **建立参考与基线。已完成。** root 在相同 1280 × 720、中文、浅色环境下查看 Multica Agents、原 Chat、GUI 首页、同一会话及菜单。`metrics-before.json`、`metrics-child-before.json` 记录父侧栏 Inter 14px / 20px、源 GUI 优先 PingFang、编辑器 13px / 24px、旧背景 `rgb(244, 245, 247)`，以及原 52px provider rail。
2. **检查字体、主题和组件角色。自动回归通过，浏览器实测已复核。** Inter/CJK 字体栈、已加载的真实 Inter 与 Geist Mono、浅深主题、`data-theme` 与 `.dark`、正文/画布/侧栏/选中/hover/菜单 token 对照均通过。`metrics-after.json` 进一步确认 Inter、画布为原 `--page-canvas`、rail 为原 `--app-shell`，首页装饰伪元素的 `content` 为 `none`；最终首页已去除游走亮线。使用源码真实选择器，不用 class 存在代替实际 computed style。
3. **检查菜单、编辑器与 portal。通过。** 两个主题下，菜单键盘导航、Escape 后回触发控件、编辑器焦点、中文草稿保留、原 56px / 24px 测量均通过。root 实测发现的重命名 portal 输入遗漏已补齐：`dialog-after.json` 为 Inter 14px / 20px、圆角 8px、高 32px、水平 padding 10px；原 13px / 16.9px、圆角 6px、高 36px 的中间证据单独保存为 `13-agent-gui-dark-dialog-before-fix.png`。重命名本地草稿取消后，原标题和 URL 保持。
4. **检查三种窗口与业务链路。通过。** 同一合成流程覆盖 1440 × 1000、1024 × 768、800 × 768；按真实 iframe 宽度检查宽窄范围，不假设父侧栏始终存在。52px rail、正文/编辑器/发送按钮边界、无整页横滚、原生侧栏恢复后的同尺寸样式隔离比较均通过。会话切换、Task 导航、真实附件 ID 绑定、取消后正文及文件恢复、同一 ID 重发也通过，未调用真实付费模型。
5. **检查完整性与工程健康。通过已执行项。** 本轮未改完整源 GUI、vendor 文件、运行时/后端协议或原生 Chat；原布局与交互继续由源模块持有。源文件完整性、依赖锁、定向测试、类型与构建的结果见下表。
6. **重启后检查原生桌面实窗。通过。** 用户解锁后，root 在 `Multica Canary multica-925` 的原生窗口中实际切换 Chat 与独立对话流，核对同一条 Codex 历史回复、浅深主题、会话右键菜单、重命名弹窗及输入焦点，取消后原标题保持。主题最后恢复为原先的“跟随系统”。截图 14–21 为本轮原生实窗证据，已逐张保存并重新读取；没有用网页截图替代桌面验收。验收初段曾出现 AX 状态改变而捕获画面停滞、刷新后空白的现象，将开发窗口移至 LG ULTRAFINE 后恢复实时更新，之后上述操作的 AX 与截图一致；未改业务代码，也未将该现象未经证明归因于路由或 GPU。

## 截图与测量证据

以下文件均位于 `.tmp/multica-gui-restoration/`。root 已实际查看表中标为“已读”的画面；浏览器和原生桌面证据分别列出。

| 编号 / 对象 | 对照文件 | 状态 |
| --- | --- | --- |
| 01 / 02：Multica 参考 | `01-multica-agents-before.png`、`02-multica-chat-before.png` | 已读，保留原 Chat 参考 |
| 03 → 08：首页 | `03-agent-gui-hero-before.png` → `08-agent-gui-hero-after.png`、`metrics-after.json` | 同尺寸、语言、浅色最终对照已读；无游走亮线，装饰伪元素为 `content: none` |
| 04 → 06：同一会话 | `04-agent-gui-session-before.png` → `06-agent-gui-session-after.png` | 对照已读 |
| 05 → 07：菜单 | `05-agent-gui-menu-before.png` → `07-agent-gui-menu-after.png` | 对照已读 |
| 10 / 11 / 12：深色 | `10-agent-gui-dark-hero.png`、`11-agent-gui-dark-session.png`、`12-agent-gui-dark-menu.png` | 已读 |
| 13：重命名 portal | `13-agent-gui-dark-dialog.png`、`dialog-after.json`；中间差异另存 `13-agent-gui-dark-dialog-before-fix.png` | 最终画面与实际输入测量已读，新增浅深主题回归通过 |
| 合成业务流程 | `e2e-conversations.png` | E2E 产物；不自动视为人工批准的视觉基线 |
| 14 / 21：原生 Chat | `14-native-chat-light.png`、`21-native-chat-dark.png` | 浅深主题已读；原聊天列表、历史回复和输入区保留 |
| 15 / 18：原生对话流 | `15-native-flow-light.png`、`18-native-flow-dark.png` | 浅深主题已读；独立标签、完整 GUI 布局及历史消息通过 |
| 16 / 19：原生会话菜单 | `16-native-flow-menu-light.png`、`19-native-flow-menu-dark.png` | 浅深主题已读；菜单位于 GUI 内，文字、表面和边界可辨 |
| 17 / 20：原生重命名弹窗 | `17-native-flow-dialog-light.png`、`20-native-flow-dialog-dark.png` | 浅深主题已读；输入自动选中、焦点环、取消行为通过 |
| 22：最终桌面状态 | `22-native-flow-restored.png`、`native-final-ax.txt` | 恢复“跟随系统”后已读；桌面保留在独立对话流，原 Chat 标签仍在 |

## 健康检查与验收矩阵

| 检查 | 结果与证据 |
| --- | --- |
| 最终 E2E，含 Rename portal | **通过**：1 个用例 17.0 秒，总计 18.3 秒；日志 `e2e.log` |
| Views 定向单测 | **通过**：9 个文件、140 项；日志 `views-test.log` |
| GUI host 单测 | **通过**：23 项；与 Views 合计 163 项 |
| Host / Desktop 类型检查 | **通过**；host 日志 `host-typecheck.log` |
| GUI host / Desktop 最终构建 | **通过**；日志 `host-build.log`、`desktop-build.log` |
| `node vendor/tutti/sync.mjs --verify` | **通过**：2,491 个源文件、22 个 metadata overlay 校验 |
| Frozen install / 锁文件 | **通过**：原有 packages / snapshots 记录 0 删除、0 修改 |
| `git diff --check` | **通过** |
| 原 Chat、独立对话流、协议 | **通过已执行回归**：各自 URL 与内容、父字体和侧栏样式保持；未改 API、事件、DTO 或 vendor |
| 加载、错误、不可调用、archived 等全部视觉状态 | **覆盖边界**：见下节风险，不由成功流程推定全状态视觉通过，不作为本轮新增签收 Gate |
| 最后原生桌面实窗 | **通过**；解锁后由 root 实际操作并读取截图 14–21，原 Chat / 独立对话流 / 浅深主题 / 菜单 / 弹窗均已复核 |

root 统一执行的合成回归命令为：

```sh
make env-exec ARGS='-- pnpm exec playwright test e2e/tutti-agent-gui.spec.ts'
```

## 剩余边界

- 源 bundle 尚未压缩，首次加载性能未建立基准；曾在并行开发编译期间遇到一次 5 秒内 iframe 未出现，原样串行重跑通过，具体根因未被证明，未因此改产品或扩大启动等待。
- Windows 打包版本未测，错误、只读和 archived 等状态尚未全量截图；没有完成全套可访问性审计，不声称 WCAG 全合规。
- 源 Dialog 取消后的实际 AX 焦点目前回到 frame；未修改源行为，也未宣称这一步会回触发控件。菜单 Escape 回触发控件已通过，两者分开记录。
- 本机多显示器验收中曾出现开发窗口画面停滞，移至 LG ULTRAFINE 后恢复；底层原因未被证明，未声称已修复所有锁屏或显示器切换场景。

浏览器和桌面主题均已恢复为“跟随系统”，当前浅色；最终首页、对话框与桌面截图均已保存并由 root 读取。root 完成设计、实现边界、工程检查和解锁后的原生桌面签收，本轮目标完成。验收 Agent 只维护测试与本文，未代替 root 操作 UI、构建或运行 E2E。

## 引用分类收敛

按用户标注，composer 的 `@` 面板只保留“会话、任务、智能体”，顺序为 `session → issue → agent`。源公共 `hiddenMentionFilterIds` 只过滤 browse 分类，results 标签和键盘循环仍读取固定五类常量；只隐藏 DOM 会使键盘选入不可见分类，未采用。宿主构建中的受校验转换统一调整该常量及中英文输入提示，vendor 文件保持原始字节、协议不变。

桌面复现还确认，未传配置时，上层视图的默认空数组会在重新渲染时改变 identity，导致 `useAgentMentionSearchController` 销毁并重建控制器：输入搜索词后回到默认“会话”及 browse 提示。宿主改为通过公开 capability 传入模块级稳定数组，避免该重置；不改源组件生命周期。

已在原生窗口检查空查询及非空查询的三类标签、Tab 正向循环、输入提示与清除草稿。`23-native-mention-categories.png` 为非空搜索状态的桌面证据，`24-native-mention-categories-session.png` 为已有会话底部同一面板的证据。当前该搜索没有可选结果，本轮没有据此声称已验收结果插入；本次范围是分类收敛。构建校验会在预期源声明变化时失败，需要重新审查适配。最终合成 E2E 1 项通过（16.8 秒，总计 17.9 秒），Host 单测 23 项、Host 类型检查、Host 构建和源完整性通过；日志为 `mention-categories-build.log`、`mention-categories-e2e.log`。过程中一次 Task 导航断言未通过，未修改该业务逻辑，后续两次串行 E2E 通过，首次失败原因未证明。

验证命令：

```sh
pnpm --filter @multica/tutti-agent-gui-host build
pnpm --filter @multica/tutti-agent-gui-host typecheck
pnpm --filter @multica/tutti-agent-gui-host test
node vendor/tutti/sync.mjs --verify
make env-exec ARGS='-- pnpm exec playwright test e2e/tutti-agent-gui.spec.ts'
git diff --check
```

## Claude Code 工作区启用

左侧目录由已有 Multica Agent 资源投影，数据流为 `agent.runtime_id → agent_runtime.provider → parent service descriptor → AgentGUI agentDirectory → provider rail`。本机的 `claude` 运行时已在线，后端 `server/pkg/agent/claude.go`、GUI provider identity 和发送适配也已支持它；当前工作区此前仅有 Codex Agent，因此左栏只显示 Codex。

通过正常 `POST /api/agents` 创建了私有 Claude Code Agent，绑定已有在线 Claude 运行时，未改数据库结构、provider 名称、执行协议或源码。本次没有新增产品执行器，也没有仅供显示的虚构 Agent。创建后的 API 目录和桌面实时目录一致，选择 Claude Code 后显示其独立新会话入口；证据为 `claude-agent-setup.json` 与已保存读取的 `25-native-claude-code.png`。

Claude 后端定向单测通过（使用测试进程），既有 GUI E2E 通过（用例 16.2 秒，总计 17.7 秒）。E2E 的测试运行时 provider 当时为 `claude`，且没有 daemon 绑定，不会执行本机 Claude。日志为 `claude-backend-tests.log`、`claude-gui-e2e.log`。用户随后明确允许一条真实验收消息，该消息经桌面发送至本机 Claude CLI；本机配置的 `glm-5.1` 服务返回 HTTP 429，提示余额不足或无可用资源包，运行终态为 failed。未发送第二条消息，未调整账号或模型配置。记录见 `claude-real-execution.json`；桌面失败卡显示为 `Unknown 请求失败`，错误分类投影尚未修复，不能将本次记为成功回复验收。

## Codex 优先回归

按用户最新要求，暂停 Claude Code 使用及验收，桌面切回 Codex，后续没有新增 Claude 调用。端到端用例明确绑定 `codex` 测试运行时，测试辅助函数保留原默认 provider，避免影响其他用例。

桌面复核发现三类引用仍返回空目录。根因是 Host 没有向源 `AgentGUI.hostCapabilities.mentionService` 注入查询服务，源控制器因此没有可查询的 provider。源契约参考 `AgentGUINode.types.ts`、`AgentMentionSearchModel.ts` 及 `ui-rich-text` 的公开 service/types 入口；宿主以新的 `createMulticaContextMentions` 接入当前工作区真实数据，不修改源组件或视觉代码。

| 源协议身份 | Multica 数据 | 宿主适配 |
| --- | --- | --- |
| `agent-session` | `ChatSession.id`、所属 Agent、创建人 | 当前工作区会话目录及关键词过滤 |
| `workspace-issue` | `Issue.id`、identifier、标题、描述 | 父文档通过现有任务 API 查询 |
| `agent-target` | `Agent.id`、名称、描述、可调用性 | 当前工作区智能体目录及关键词过滤 |

保留源 provider ID、entityId、scope 和 mention Markdown 契约。新增私有 Host RPC `context.tasks`，并为私有 `session.send` 增加可选 `references`；没有改 Multica 的 HTTP 路径、公开请求字段、响应字段、鉴权、WebSocket 事件或运行状态。父文档重新核对所选对象的工作区归属，在已有 `content` 字段中提供所选内容快照，再通过原发送链路交给 Codex。任务分配与执行继续由 Multica 任务页管理，此处提供上下文引用和任务跳转。

源查询、分组、插入和键盘交互继续使用原实现。新适配采用 Multica 的目录、Query 缓存和权限检查；凭据留在父文档，跨工作区及失效异步结果在提交前拒绝。取消后重发会替换旧快照，避免重复附加。一次真实桌面验收暴露了内部快照显示在气泡中的问题，已将完整执行内容与用户输入分开：GUI 投影、原 Chat 气泡和恢复草稿展示用户输入，持久化记录仍保留执行上下文。普通聊天布局和交互保留。

最终验证通过：Host 单测 26 项、Views 单测 63 项、Core 单测 1 项，共 90 项；Host / Views / Desktop 类型检查、定向 lint、Host 构建及源完整性校验通过。最终 E2E 1 项通过（18.9 秒，总计 20.0 秒，`codex-context-e2e.log`），覆盖三类查询、实际选择、提交的上下文内容、原 Chat 的消息展示、取消恢复、重发不重复、新建 Codex 会话、附件、主题、任务链接及独立标签。测试运行时不绑定 daemon，不消耗模型额度。最后的跨页检查曾因重载原 Chat 后未切回前台而无法停止，已补上显式切回和焦点确认；开发刷新期间还出现过一次会话 URL 同步断言失败，未在最终串行回归复现，不宣称已证明其底层原因。

本机 Codex 真实引用验收另行通过：运行 `01a16b63-0aed-7261-86ab-9f5dc90a7151` 以 `completed` 结束，9 秒内正确返回引用任务描述首句 `Connection acceptance check.`；仅记录 text 事件，没有工具调用。记录为 `codex-context-real-execution.json`。原生桌面同时检查原 Chat 的同一条消息及已有 DEV-1 的评论和执行日志。最终证据为 `29-native-codex-reference-search.png`、`30-native-codex-context-accepted.png`；输入区已清空并停留在 Codex 对话流。

引用边界：每条消息最多 5 个对象；任务快照包含标题和描述，智能体快照包含名称和描述，会话快照取最近 12 条文本消息，每个快照最多 6,000 字符，并在执行内容中标记省略或截断。引用会话的附件不随文本快照自动上传。跨原 Chat 与对话流的引用恢复及再次发送尚未做全组合验收；本轮重点验收对话流内的引用发送与取消恢复。Windows 和签名安装包不在本轮范围。

复核命令：

```sh
pnpm --filter @multica/tutti-agent-gui-host test
pnpm --filter @multica/tutti-agent-gui-host typecheck
pnpm --filter @multica/tutti-agent-gui-host build
pnpm --filter @multica/core exec vitest run chat/context-snapshot.test.ts
pnpm --filter @multica/views exec vitest run tutti-agent-gui/parent-service.test.ts tutti-agent-gui/tutti-agent-gui-panel.test.tsx tutti-agent-gui/conversation-flow-page.test.tsx chat/components/chat-message-list.test.tsx chat/components/use-chat-draft-restore.test.tsx
pnpm --filter @multica/views typecheck
pnpm --filter @multica/desktop typecheck
make env-exec ARGS='-- pnpm exec playwright test e2e/tutti-agent-gui.spec.ts'
node vendor/tutti/sync.mjs --verify
git diff --check
```
对话页的队列在 dock 表单中按正常文档流排版，与输入框共用 `--agent-gui-detail-padding-x` 留白。报错及恢复提示在队列上方保留 8px 间隔；输入区按实际高度占位，多行内容和附件不会向上遮盖队列。深浅主题、宽窗口和窄窗口的回归比较两者实际左右边界及文字起点，偏差不超过 1px，并检查报错、折叠/展开队列与多行输入区依次排列且没有重叠。

## 静态资源发布

封面加载在展示边界使用 GUI 自带的 provider 归一化，确保本机 `claude` 对应 `claude-code` 的内置唱片封面；保留本机 CLI 和会话协议中的原标识。欢迎页回归同时检查 Codex 与 Claude 封面均已请求并成功返回图片响应，避免只验证 DOM 唱片中心图标而漏掉两侧 WebGL 封面。

GUI 构建保留 `dist` 的清洁输出，发布到 web/desktop 的 public 目录时保留已有资源，并在资源复制完成后原子替换 `index.html`。已打开的窗口仍可能延迟加载旧哈希的图片、字体或代码块；相同内容的图片也可能因构建去重而采用不同源文件名，不能在发布新入口时删除旧资源。

public 目录中的旧资源可在关闭本地应用与开发服务后清理。生产构建从干净 checkout 生成，不需要携带本地开发积累的版本。发布回归运行 `node --test packages/tutti-agent-gui-host/scripts/publish.test.mjs`，也包含在 GUI host 的 `test` 命令中。
