# 对话流图片预览

用户发送的每张图片使用独立的 80px 圆角方卡，缩略图裁切填满，点击后仍按原图比例查看。粘贴、本地上传和多图消息共用同一套展示。

Agent 生成的图片和正文 Markdown 图片均限制在 260px × 260px 范围内，保留完整原图比例，不拉伸或裁切。点击缩略图使用已有大图查看器；大图尺寸、缩放、复制和下载不受缩略图限制。

本机 Codex / Claude Code 的结构化图片结果转换为 `ImageGeneration` 展示事件。图片字节保存到当前账号与工作区的附件目录，事件只保留 `/multica-local-images/<id>/<name>` 引用；GUI 将该事件的输出还原成对象，交给已有图片产物组件渲染。普通工具诊断中的图片字节被移除，避免在会话 JSON 中重复保存。

Codex 的代码模式工具可能只在原生记录及 `generated_images/<providerSessionId>` 留下图片，而当前 GUI 历史只保存了文字。主进程在读取会话及执行结束时检查该原生会话的生成目录，按文件修改时间所处的已结束轮次恢复图片。只检查普通图片文件，排除符号链接，限制文件大小，并按文件名去重。恢复后图片进入 Multica 附件目录，重启、分叉及原生文件被移除后仍可查看；恢复不调用模型，也不重新生成图片。

GUI 通过 `image.read` 调用桌面 `imageRead`。附件引用必须出现在当前会话的图片产物事件中；Markdown 本机图片只能读取当前会话工作目录内的文件，沿用真实路径及符号链接越界检查。接口只返回图片，不能借此读取任意本机文件。网页宿主不开放此本机接口，远程 HTTPS 图片保持原有渲染路径。

`image.read` 与附件读取一样允许在窗口失焦、标签页隐藏时继续完成，写入操作仍受前台检查限制。执行结束时，如果历史读取触发的图片扫描尚未结束，先等待它，再补做完成后的扫描，避免复用运行中尚未发现图片的结果。图片保存后发送原有失效通知，当前会话直接更新，不需要切换会话。

两种运行器的追加提示词均说明图片支持和 Markdown 输出格式，要求普通文件输出保存到会话工作目录并提供图片链接。

验证：

```sh
pnpm --filter @multica/desktop test src/local-host/local-output-images.test.ts src/local-host/local-output-images.integration.test.ts src/local-host/local-provider-runner.test.ts src/local-host/local-conversation-service.test.ts src/renderer/src/platform/local-conversation-service.test.ts
pnpm --filter @multica/tutti-agent-gui-host test src/runtime/runtime.test.ts src/local-protocol.test.ts
pnpm --filter @multica/views test tutti-agent-gui-panel
pnpm --filter @multica/desktop test src/renderer/src/platform/local-conversation-service.test.ts src/renderer/src/pages/local-conversation-flow.test.tsx
pnpm --filter @multica/desktop typecheck
pnpm --filter @multica/tutti-agent-gui-host typecheck
pnpm --filter @multica/tutti-agent-gui-host build
PLAYWRIGHT_BASE_URL=http://localhost:16099 pnpm exec playwright test e2e/local-image-input.spec.ts e2e/local-provider-gui.spec.ts
pnpm --filter @multica/desktop build
```

历史恢复依赖原生图片文件仍存在，且文件修改时间保留在原轮次时间范围内。已删除、被外部修改时间或超出大小限制的原生图片无法自动恢复。Claude 过去已丢弃的图片结果也不能凭文字重建；新的结构化图片和 Markdown 本机图片均走上述完整链路。
