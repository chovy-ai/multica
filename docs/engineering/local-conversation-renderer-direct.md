# 渲染进程直连守护进程

日期：2026-10-29。状态：已实现（本 PR）。代码现状基于 #82 合入后的 main（Go `/local/v2` 服务）。

原则：渲染进程尽量直接连本机守护进程，只有渲染进程做不到的事才经过主进程。

这是本地对话架构的独立改造，先于[设备互联](./device-link-conversations.md)合入。设备互联在它之上实现，查看端不需要按设备维护主进程代理。

## 现状和改动

现在主进程承担两类工作。一类是转发数据（`apps/desktop/src/main/local-conversation-v2.ts` 的 `LocalV2Proxy`，以及 `multica-local-file://` 协议），这部分改为直连。另一类是做渲染进程做不到的事，这部分保留。

`LocalV2Proxy` 和 `multica-local-file://` 当初放在主进程（#40、#82），是为了让守护进程 token 不进渲染进程。本方案改为给渲染进程一组由该 token 派生、权限受限的凭据，并把需要原生能力或扩大权限的操作留在主进程。

现在主进程承担两类工作：一是转发数据（`LocalV2Proxy`、`multica-local-file://` 协议），这部分改为直连；二是做渲染进程做不到的事，这部分保留。

| 能力 | 走向 | 说明 |
| --- | --- | --- |
| JSON 请求（会话、命令、配置、预览元数据、导入…） | 直连 | `fetch` 带 `Authorization: Bearer {渲染进程 token}` |
| WebSocket | 直连 | 浏览器 WebSocket 不能带请求头。先 `POST /local/v2/ws-ticket` 换一次性票据（30 秒、单次有效），再连 `ws://…/local/v2/ws?ticket=…` |
| 文件读取（附件、会话图片、预览内容） | 直连 | URL 带文件 key 和 scope 参数，`<img>`、`<video>` 直接使用，支持 Range。文件 key 只能打开文件路由，token 不进 URL |
| 附件上传 | 直连 | `fetch` POST，带渲染进程 token |
| 反向请求 | 直连接收 | 渲染进程从 WS 收到 `host.request`；需要原生能力的部分再经 IPC 交给主进程，结果由渲染进程 `host.reply` |
| 获取端口和渲染进程凭据 | 主进程 | 渲染进程读不到 profile 文件。IPC `local-v2:endpoint` 返回 `{ base, apiUrl, token, fileKey }`；被拒（非 JSON 的 403）时再取一次（守护进程重启后轮换） |
| 扩大读取范围（`/folder-projects`、`/preview/roots`、`set_directory`） | 主进程 | 路径必须来自原生选择器，守护进程分不清路径是用户选的还是伪造的。只接受主进程 token |
| 设置确认、设备设置操作 | 主进程 | 原生弹窗和登录凭据。主进程用 `packages/core/settings/operations.ts` 根据确认框展示的 operation 和 input 重新生成写入请求，不使用经渲染进程转来的 `apply` |
| Side 浏览器、网页预览 | 主进程 | `WebContentsView` |
| 文件右键菜单、Side 浏览器同步、开发者日志 | 主进程 | 主进程用自己的 token 读取。渲染进程写入 Side 布局后调用 `side-workspace:reconcile`，主进程从守护进程读回已接受的布局，再同步浏览器 tab |
| `/drain`、`/undrain`、`/stop-providers` | 主进程 | 更新流程，只接受主进程 token |

## 守护进程（`daemon/localhost/auth.go`、`v2.go`）

- 凭据：现有主进程 token 不变。渲染进程 token 和文件 key 都由主进程 token 派生（`HMAC-SHA256(token, "multica-local-renderer")`、`HMAC-SHA256(token, "multica-local-file")`），随守护进程每次启动轮换，不新增凭据文件；主进程用同样的算法计算后交给渲染进程。Go 和 TS 两边用同一组测试向量校验。
- Origin（2026-10-29 用 Electron 44.9.3 实测，窗口配置与 Desktop 相同：`sandbox: true`、`webSecurity: false`）：

  | 请求 | 生产（`file://`） | 开发（`http://localhost:{port}`） |
  | --- | --- | --- |
  | `fetch` GET/POST（带 `Authorization`） | 不带 Origin，无预检 | 不带 Origin，无预检；`webSecurity: true` 时带 Origin 并先发预检 |
  | WebSocket | `Origin: file://` | `Origin: http://localhost:{port}` |
  | `<img src>` | 不带 Origin，也带不了请求头 | 同左 |

  结论：HTTP 请求无法用 Origin 区分主进程和渲染进程，两者的权限只能靠两个 token 区分。渲染进程凭据接受「不带 Origin」、`file://` 和回环地址的 http(s) origin（开发环境的 dev server）。其他网站即使拿到 URL，没有凭据也无法访问。主进程 token 仍要求不带 Origin。回环 Host 检查保留。
- CORS：开发环境如果打开 `webSecurity`，需要对白名单 origin 响应预检，允许 `Authorization`、`Content-Type`、`X-File-Name`、`X-Multica-*`、`Range`。WS 的 `CheckOrigin` 使用同一个白名单，所以生产环境必须放行 `file://`。
- 票据和文件 key：浏览器的 WebSocket 和 `<img>` 都带不了 Authorization 和 scope 请求头。
  - `POST /local/v2/ws-ticket` 用渲染进程 token 换一次性票据（30 秒），票据绑定发起请求时的 scope。
  - 文件 URL 带 `file_key`、`api_origin`、`user_id`、`workspace_id` 参数，只允许 GET 附件、会话图片和预览内容三类路由。`scope()` 仍校验账号。
  - 入口层校验后，把票据或参数还原为 scope 请求头，再交给策略层和能力层，所以能力层看到的请求和带请求头的请求一样。
- Origin 检查只放在入口层。现在 `NewV2` 的 upgrader 写死了 `CheckOrigin: Origin == ""`，要移到入口层，由入口按 token 类型决定接受哪些 Origin。

## Desktop

- 删除 `apps/desktop/src/main/local-conversation-v2.ts` 的数据转发、`local-v2:request`/`send`/`message`/`connection` IPC 和 `multica-local-file://` 协议。主进程只保留 `local-v2:endpoint`、`local-v2:choose`、host request 的原生部分、保存到本机，以及 drain 流程用的主进程客户端。
- 渲染进程新增直连的 `LocalV2Transport` 实现（`renderer/src/platform/local-v2-transport.ts`）：HTTP、WS 票据、断线重连、availability、文件 URL、上传，以及把 host request 交给主进程后回复。`LocalV2Transport` 接口不变，页面只改获取 transport 的位置。
- 渲染进程侧的路径检查（`isLocalV2RendererPost`、`isLocalV2FilePath`）删除，改由守护进程的策略表和文件路由白名单执行。

## 分层

守护进程的能力只有一份。入口层只负责认证并得出调用方（caller），由一张策略表决定权限，能力层不区分调用方。设备互联在这个基础上增加 `remote` 调用方（见设备互联文档）。

```text
入口层：主进程 token → caller{main}
        渲染进程 token、WS 票据、文件 key → caller{renderer}
策略层：caller × 路由 → 允许或拒绝
能力层：现有 V2 路由和 localconversation service
```

| 路由 | main | renderer |
| --- | --- | --- |
| 会话、命令、配置、预览读取、附件、导入、WS | ✓ | ✓ |
| `ws-ticket` | ✓ | ✓ |
| 扩大读取范围：`/folder-projects` POST、`/preview/roots`、`set_directory` | ✓ | ✗ |
| `/drain`、`/undrain`、`/stop-providers` | ✓ | ✗ |

## 安全边界

| 层级 | 检查 |
| --- | --- |
| 回环入口 | loopback Host；主进程 token 不能带 Origin；渲染进程 token、WS 票据和文件 key 只接受 Desktop 的 origin；文件 key 只能 GET 文件路由 |
| 策略表 | 渲染进程不能扩大读取范围、不能 drain 或停止 provider |
| 能力层 | `scope()` 每次请求校验账号 |

已知风险：

- 渲染进程持有渲染进程 token。渲染进程被注入时，可以读取会话、在本机运行智能体，但不能扩大读取范围、关闭守护进程或执行 drain。
- 需要确认的设置写入由 `packages/core/settings/operations.ts` 生成，Go `settings/routes.go` 生成的请求不再用于这类写入。两边的操作定义需要保持一致。

## 验证

- Go（`daemon/localhost/caller_test.go`）：各凭据的 Origin 规则、非回环 Host、渲染进程不能访问的路由、票据单次有效和过期、票据携带 scope、文件 key 只开放文件路由且仍校验账号、与 Desktop 一致的派生值。
- Desktop：主进程客户端的请求和派生凭据；直连 transport 的 availability、错误类型、凭据轮换、文件 URL、票据连接、host request 回复、断线重连；设置确认使用重建的写入请求。
- 实测（2026-10-29，macOS，Electron 44.9.3，窗口配置与 Desktop 相同）：`file://` 页面对真实 v2 服务用渲染进程 token 读取会话 200、调用 drain 403；票据连接 WS 并订阅成功；文件 key 的 fetch 和 `<img>` 都能加载。
- 未做：Windows 和 Linux 打包产物上的 Origin 复测；完整 Desktop 应用的手动验证。

## 后续

`renderer-web-preferences.ts` 计划以后恢复 `webSecurity`，并改用自定义协议加载页面。届时 Origin 会变成自定义协议的 origin，白名单要同步更新；开发环境打开 `webSecurity` 后需要 CORS 预检。
