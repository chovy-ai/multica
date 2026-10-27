# 对话流 HTML 与 SVG 预览

对话流将回复中标记为 `html` 或 `htm` 的 Markdown 代码块显示为 HTML 预览卡片，支持内联 CSS、JavaScript、SVG 和 canvas。卡片提供预览、源码、复制、展开和重新运行。HTML 原文仍作为普通消息内容保存，历史会话无需迁移。

标记为 `svg` 的代码块使用同一卡片展示独立矢量图，支持 25%–400% 缩放、适应面板、展开、源码切换和复制原文。100% 表示适应当前面板；缩放不栅格化原始图形。已有会话中的 SVG 代码块也会按相同规则展示。

点击 SVG 图像或工具栏的展开按钮可打开覆盖整个应用窗口的全局弹窗，键盘 Enter/Space 也可从图像进入。大预览支持原有缩放、适应面板、源码、复制和重新加载；关闭按钮、Esc（包括图像内焦点）或点击遮罩返回内嵌预览。外层宿主通过原生 dialog 的 top layer 提升原 GUI iframe，内层保留原 SVG dialog，不移动到 portal，因此放大和关闭不重载图像、不重置缩放；占位保留消息布局，关闭后恢复原分栏和展开按钮焦点。HTML 卡片原有内嵌展开方式保持不变。

全局展示使用两个只涉及 UI 的窗口消息：GUI 向父窗口发送 `{type: "multica:agent-gui:preview-state", version: 1, expanded: boolean}`；父窗口需要关闭时发送 `{type: "multica:agent-gui:preview-close", version: 1}`。父窗口校验来源 iframe、同源 origin、版本、布尔字段以及当前账户/工作区，隐藏的 GUI 不能弹出。预览只接受所属父窗口的关闭消息。切换到后台标签、上下文失效或 GUI 文档重载时收起全局展示。右侧原生网页视图监听 dialog 的 role/open 变化，在弹窗展示期间隐藏，关闭后恢复。没有新增业务 RPC 或服务端接口。

## 渲染与兼容

数据流：CLI 回复 → 本机消息原文 → 原有 Markdown 渲染器 → 预览代码块适配器 → 独立沙箱 iframe。新代码位于 `packages/tutti-agent-gui-host/src/html-preview/`。

SVG 路径在沙箱内解析 XML、确认根节点和命名空间，再通过 SVG image context 渲染，原 SVG 节点不进入宿主 DOM。缺少默认 SVG 命名空间时自动补齐；根节点 `title` 用作图像的无障碍标签。主题变量注入图像自身的样式，内部渐变、marker 和 use 引用保留。独立 SVG 不加载 Chart.js/D3；图像中的脚本和外部资源不可用，需要脚本交互时应使用 HTML 块内的 SVG。机制参考 [SVG as an image](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)。

`vite.config.ts` 在已有宿主适配机制中替换 `MarkdownPre` 的导入；源码快照保持不变，固定锚点变化时构建直接失败。普通代码、行内代码和 Mermaid 继续使用原渲染器。流式回复只展示等待状态，完成后才创建可执行的预览，避免每次文本更新都重置交互。

工具栏使用 Multica Button 和语义样式；预览文档获得当前主题的 `--background`、`--foreground`、`--muted`、`--muted-foreground`、`--border`、`--brand`。Chart.js 的默认文字与坐标轴也随主题变化，不覆盖其数据系列配色。切换源码保留 iframe 的交互状态；重新运行或切换主题会重新创建预览。

## 可用库与输出约定

- 内置 Chart.js 4.6.1，使用全局 `Chart`。
- 内置 D3 7.9.0，使用全局 `d3`。
- 两个库由已声明的包依赖在构建时读取其 UMD 文件，按需加载，然后以内联脚本注入沙箱；不依赖 CDN。发行资源保留两者许可证。
- 每块 HTML 上限为 256,000 字符；超过时仍可查看和复制源码。
- 不提供 React、JSX、Tailwind、外部脚本、网络取数或本地文件读取。数据应直接嵌入文档，图片可使用 data URL。

[Chart.js 的脚本集成](https://www.chartjs.org/docs/latest/getting-started/integration.html)与 [D3 的 UMD 集成](https://d3js.org/getting-started)是本地打包方式的参考。

能力说明统一定义在 `html-preview-contract.ts`。本机每次执行，包括续聊，都会将它追加到运行上下文：Codex 沿用现有原生 developer instructions 注入方式，保留已有配置；Claude Code 使用 `--append-system-prompt`。说明要求模型在合适时输出 `html` 或 `svg` 围栏代码块，SVG 提供 xmlns 和 viewBox，直接使用内置库、适配主题，并避免声称仅写入磁盘的文件已成为预览。原 Multica 查询指令继续保留，提示词不作为用户消息保存，也不修改用户的全局 CLI 配置。

流程图、工作流和过程图默认使用自包含的 `svg` 代码块，不默认生成 Mermaid 或纯文本图；用户明确指定其他格式时遵循用户要求。需要脚本交互的可视化和控件仍使用 `html`。此约定同时注入 Codex 和 Claude Code 的新会话与续聊，包括旁支执行。

Electron 主程序将该纯文本模块直接打包，产物不依赖运行时读取工作区的 TypeScript 源码。

## 隔离与错误处理

HTML 不插入宿主 DOM。iframe 只设置 `sandbox="allow-scripts"`，不赋予同源、表单、弹窗、顶层导航或下载权限；文档首先设置 CSP，仅允许内联脚本和样式，以及 data/blob 图片。相关机制见 [MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox)。

脚本错误、未处理的 Promise 拒绝、资源策略错误在卡片内显示。宿主只接收来自当前 iframe、opaque origin、当前随机通道的就绪、错误以及 SVG 展开/收起事件，不提供业务 RPC。Electron 额外拦截 `about:srcdoc` 文档及其发起的跨文档导航，避免脚本通过修改 location 离开预览。原有应用窗口导航规则保留。

## 验证

```sh
pnpm --filter @multica/desktop test src/local-host/local-conversation-service.test.ts src/local-host/local-provider-runner.test.ts src/main/html-preview-navigation.test.ts src/local-host/local-codex-instructions.test.ts
pnpm --filter @multica/tutti-agent-gui-host test
pnpm --filter @multica/tutti-agent-gui-host typecheck
pnpm --filter @multica/desktop typecheck
pnpm --filter @multica/desktop build
PLAYWRIGHT_BASE_URL=http://localhost:16099 pnpm exec playwright test e2e/agent-html-preview.spec.ts e2e/local-provider-gui.spec.ts --trace retain-on-failure
git diff --check
```

GUI 端到端用例通过原 MessagePort 协议提供合成的本机 Codex / Claude 回复，覆盖按钮交互、实际 Chart.js 与 D3 渲染、源码切换、重新运行、展开、深浅主题、语言切换、流式完成、脚本错误以及原 Markdown / Mermaid。隔离断言覆盖宿主 DOM、localStorage、桌面桥接和被 CSP 拦截的网络请求，不创建线上会话或调用模型。

另在独立 Electron 44 进程中运行生产文档构造器和导航守卫：Node 与桌面桥接不可见，宿主 DOM 和存储不可访问，修改 location 的导航被阻止，测试网络请求为 0。测试记录位于 `.tmp/local-conversations/html-*.log`，深浅主题截图为 `html-codex-preview.png`、`html-codex-light.png` 和对应 Claude 文件。源码清单 2,491 个 vendored 文件的哈希保持一致。

HTML 初次验收记录：65 项相关自动测试、3 条 HTML 端到端场景、类型检查、改动范围 lint 和桌面构建通过。原草稿切换场景曾在输入 `@` 后出现一次建议菜单的时序失败，原构建单独复跑及随后连续两轮均通过，本次未修改该交互。未调用真实 Codex / Claude 模型。主桌面已重启、接口与渲染日志正常；锁屏使桌面工具无法进行最后的实窗复核，此项尚未计为通过。

SVG 扩展追加 3 条端到端场景，分别验证两种运行器回复的矢量图、缩放与复位、源码切换保留缩放、深浅主题，以及流式等待和错误隔离。用例同时覆盖渐变、marker、use、带空白的 XML 声明、缺省 xmlns；确认 SVG 脚本未执行、外部资源没有请求、SVG-only 会话不下载图表库。截图位于 `.tmp/local-conversations/svg-{codex,claude}-{dark,light}.png`，日志使用 `svg-*.log`。

本次 SVG 扩展的 62 项相关自动测试（桌面 21、宿主 41）、6 条 HTML/SVG 端到端场景、类型检查、相关 lint 和桌面构建通过。独立 Electron 进程进一步确认 SVG 解码成功、缺省命名空间已补齐、125% 缩放生效、SVG 脚本没有执行、外部资源请求为 0、未加载图表库及桌面桥接。仍未调用真实模型。

点击放大补充验收：完整 HTML/SVG 套件 8 条端到端场景通过，新增两种运行器的点击/键盘进入、大预览重复开关、Esc/遮罩关闭、iframe 与缩放保留、消息布局稳定、深浅主题和中文控制文案检查。宿主文档/代码块 6 项单元测试、类型检查、改动范围 lint 和桌面构建通过。浏览器截图为 `.tmp/local-conversations/svg-{codex,claude}-expanded{,-light}.png`，未调用真实模型；本轮未完成原生桌面实窗复核。

后续实窗复核已完成：当前桌面窗口此前保留旧 GUI iframe，构建静态资源不会替换其正在执行的脚本。确认无执行中任务或未发送文字后，使用 View → Reload 加载新 GUI；用户已有流程图可直接点击放大，Esc 可返回并恢复展开按钮焦点。实际桌面截图为 `.tmp/local-conversations/svg-native-expanded.png`。无需重新生成图像或改动历史记录，未调用模型。

全局弹窗验收：HTML/SVG 套件 10 条端到端场景通过；全局宿主/面板 11 项、右侧资源工作区 3 项组件测试通过。覆盖整个窗口的边界、关闭后原 iframe 和缩放保留、源码切换、背景草稿、窄窗口、伪造消息、失效作用域、隐藏宿主、重载关闭及原生网页避让。类型检查、相关 lint 和桌面构建通过。Mac 实窗使用用户原有流程图验证全局覆盖与 Esc 返回，截图 `.tmp/local-conversations/svg-native-global.png`。仍未发送真实模型请求。
