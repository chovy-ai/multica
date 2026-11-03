# Multica iOS：AI 会话交互对齐

以同一个 iOS App 已有的场景作为参照。相同操作复用同一实现；AI 的设备连接、引用上限、调用和排队规则保持业务边界。

## 场景清单

| 场景 | App 内参照及规则 | AI 会话调整 |
| --- | --- | --- |
| 分类/范围切换 | [我的任务](../../app/(app)/[workspace]/(tabs)/my-issues.tsx)：描边小按钮，选中使用 accent 底色，点击立即切换 | 从现有实现抽出 [ScopeButtons](../../components/ui/scope-buttons.tsx)，由任务列表、引用分类和 Side 分类共同使用；默认 36 pt，长文案可横向滚动 |
| 单选属性 | [优先级选择器](../../app/(app)/[workspace]/issue/[id]/picker/priority.tsx)：原生 formSheet，点击选择后返回父层 | 模型、思考强度和执行权限使用独立 setting 路由；提交成功只返回一层；手动关闭后到达的响应不再次导航 |
| 多选 | [标签选择](../../app/(app)/[workspace]/issue/[id]/picker/label.tsx)、[普通 @](../../components/issue/pickers/mention-picker-body.tsx)：点击即时更新，保留弹层供继续勾选，下拉关闭保留选择 | 引用选择直接写入隔离草稿，移除额外的取消/完成步骤；保留 5 项上限、跨分类选择和智能体头像 |
| 可搜索选择器 | [负责人选择](../../app/(app)/[workspace]/issue/[id]/picker/assignee.tsx)：原生搜索栏，取消清空搜索 | 引用、模型和 Side 会话选择共用 [useNativeSearchBar](../../lib/use-native-search-bar.ts)；保留防抖、独立分页和搜索时的滚动行为 |
| 只读/管理列表弹层 | [聊天会话列表](../../app/(app)/[workspace]/chat-sessions.tsx) 与 [SHEET_OPTIONS](../../lib/sheet-options.ts)：原生拖拽、停靠高度、滚动和关闭 | 队列移除自定义遮罩、动画和 PanResponder；设置、用量、文件夹等面板不再额外放一个无提交行为的“完成”按钮 |
| 列表内单选会话 | [聊天会话列表](../../app/(app)/[workspace]/chat-sessions.tsx)：选中行背景、勾选标记，点击后返回 | Side 会话列表采用相同选择行为；新建入口放在标题栏，等待创建成功后进入 |
| 工具栏入口 | [HeaderActions](../../components/ui/app-header-actions.tsx)、[MessageComposer](../../components/composer/message-composer.tsx)：导航工具与输入工具分别按各自的尺寸体系 | 保持导航图标按钮 40 pt、输入工具 32 pt；相同分类操作共用 36 pt 按钮，不按 AI 页面另设尺寸 |
| 图片/文件附件 | [MessageComposer](../../components/composer/message-composer.tsx)：图片进入系统相册，文件进入系统文件选择器，选择后回到输入区 | AI 输入区提供相同的两个入口；沿用设备附件传输、预览和独立移除，选择后恢复输入焦点 |
| 问题选项与表单提交 | [属性选择器](../../components/issue/pickers/priority-picker-body.tsx) 的行选中反馈，与现有表单的显式提交 | 问题的单选/多选使用行与勾选反馈，继续通过提交答案按钮发送完整回答 |
| 上下文菜单 | [消息长按](../../components/chat/message-long-press.tsx) 使用原生 action sheet；[更多导航](../../components/nav/more-tab-dropdown.tsx) 使用共享锚定菜单 | 现有会话操作使用原生 action sheet，新建运行器菜单沿用共享 DropdownMenu；不另建弹出层体系 |

## 状态流

多选：点选 → 草稿立即更新 → 可继续勾选/取消 → 原生返回或下拉关闭 → 输入区显示当前引用。

单选设置：设置面板 → 原生属性选择页 → 请求提交 → 成功刷新设置并返回父层；失败保留当前页供恢复。原生搜索栏在路由定义中注册标题栏，避免弹层出现后再切换标题栏。

选中数量放在分类下方的列表头，避免自定义底栏被 iOS 26 的系统搜索栏遮住。搜索变化时，列表回到顶部。

搜索取消只清空搜索条件。未点选任何引用时关闭选择页，未完成的 `@` 输入保持原样；点选时只移除仍匹配原位置的触发文本。待发送请求锁定期间禁止更改引用。

## 保留的业务规则

- 会话按目录首次请求 8 条，每个目录独立加载更多；引用各分类和 Side 会话也保留 8 条分页。
- 引用最多 5 项，智能体调用权限与头像保持原有实现；选择本身不启动智能体。
- 文件夹的点击用于进入目录，显式选择当前目录仍使用确认按钮；问答仍需提交完整回答。
- AI 的发送、排队、停止和模型配置保留既有协议，附件仍传输到选定电脑。

## 验证

```bash
pnpm --filter @multica/mobile typecheck
pnpm --filter @multica/mobile lint
pnpm --filter @multica/mobile test
git diff --check
```

54 个测试文件、409 项测试通过；新增草稿回归覆盖即时多选、关闭保留、匹配触发文本、发送锁定及上限内取消。
原生开发版使用独立的 `review-device` 路由与进程内测试数据验证交互，模型设置响应由内存传输模拟，不向真实电脑写入配置或启动模型。真实设备端到端验证仍需此前的分页守护进程更新。

原生 Debug 重建成功。使用内存传输检查了引用首次 8 条和下一页、关闭后的选择保留、模型提交后返回父页及原生队列弹层。检查后已清理测试草稿和 Query 数据并返回电脑列表。软件键盘弹出后的最终布局、真实相册/文件选择以及设备端到端场景仍需补验。
