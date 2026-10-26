# 对话流 @ 面板细节

原先任务候选沿用了 Tutti 的状态词表和产物入口。Multica 的 `done`、`blocked`、`in_review` 等状态因此直接显示机器值；产物入口则没有对接有效的引用文件查询。长标题、粗字重与右侧操作一起挤占了列表宽度。

任务引用仍使用原有查询、选中和插入链路。宿主在渲染边界提供任务行：任务号、可省略的标题、状态分别布局，完整标题保留为悬停提示，不提供未实现的产物操作。状态使用 Multica 的内置中英文名称和生命周期语义色，自定义及已归档状态从工作区状态目录读取真实名称。未知状态保留其原始键，不推测为待办；状态目录读取失败时，任务列表仍可查询。

状态目录由宿主的 TanStack Query 缓存管理，工作区切换后不会复用其他工作区的数据。扩展的展示字段只经过现有私有 GUI 桥和 mention presentation，不改变官方 Server 的请求协议、任务状态值或引用身份。

面板标签栏与底部快捷键区使用不透明的 Multica 表面色，滚动区保留内边距，任务行使用共享 Badge 和语义字体。源快照不修改；固定版本的展示适配仍在宿主 Vite 转换中完成，并保留上游变动检测。

加载更多时保留已有候选，在列表底部使用 Multica 的共享 Spinner 和现有翻译显示加载态。分组分页与搜索分页均禁用加载入口的重复点击；完成后恢复普通入口或移除已无下一页的入口，分组请求失败时保留重试入口。

截图中的半行可在手动滚动时出现；初次展开没有首行被标签栏遮挡的问题。回归检查的是键盘选中项始终完整位于标签栏和底栏之间，不通过吸附滚动改变原有操作方式。

验证：

```sh
pnpm --filter @multica/tutti-agent-gui-host test
pnpm --filter @multica/views test tutti-agent-gui/parent-service.test.ts
pnpm --filter @multica/tutti-agent-gui-host typecheck
pnpm --filter @multica/desktop typecheck
pnpm --filter @multica/desktop build
PLAYWRIGHT_BASE_URL=http://localhost:16099 pnpm exec playwright test e2e/tutti-mention-panel.spec.ts e2e/agent-html-preview.spec.ts
git diff --check
```

69 项相关单元测试和 10 个端到端场景通过。面板覆盖中英文、深浅主题、420–1440px 宽度、长标题、自定义状态、上下键滚动、回车插入、无结果和 Escape 返回编辑器；原有 HTML/SVG 预览也通过回归。测试使用合成消息及模拟接口，没有模型调用或线上数据写入。
