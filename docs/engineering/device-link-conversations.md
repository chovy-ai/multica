# 设备互联对话流

在本机 Desktop 中，通过已有的 p2p 设备链路使用同账号另一台设备上的本地对话流。功能名为**设备互联**（英文 **Device link**）。「Relay」只保留传输层含义：两台设备无法直连时，由 libp2p circuit relay 转发连接。

## 范围

第一版包含：

- 被访问端的开关：允许同账号的其他设备使用本机对话流，默认关闭。
- 每台可用设备对应一个对话流侧边栏入口和 tab。没有可用设备时，侧边栏保持不变。
- 远端 tab 复用对话流界面，目录、Session、消息、运行、模型和文件都读取远端设备，执行也在远端设备上。
- 通过现有的事件游标和重新同步机制实现实时更新和重连。
- 优先直连，尽量不经中继。

暂不包含：

- 两台设备同时操作同一个 Session 时的协调。不做限制，也不额外提示。
- 设置中的设备列表和逐台管理。侧边栏入口是临时方案。
- Session 跨设备迁移，以及离线设备的展示。

## 交互

### 设置 → 本设备 → 设备互联

仅 Desktop 提供，通过 `extraDeviceTabs` 加在实验室和守护进程旁边。p2p 未启用时不显示。页面只有一个 `Switch`：

| 元素 | zh-Hans | en |
| --- | --- | --- |
| Tab | 设备互联 | Device link |
| 开关标签 | 允许其他设备访问本机对话流 | Allow other devices to use conversations on this device |
| 开关说明 | 同一账号的其他设备可以查看本机对话、读取对话中的文件，并在本机运行智能体。 | Other devices signed in to this account can view conversations on this device, read their files and run agents here. |

保留这句说明，是因为它说明的是权限后果（见开发规范「UI 描述性文案」）。页头等其他位置不再重复。

打开开关时弹出 `AlertDialog`（重要操作确认，见 `packages/ui/docs/dialog.zh.md`）：

- 标题：允许其他设备访问本机？ / Allow other devices to use this device?
- 说明：它们可以在本机运行智能体并读写本机文件。 / They can run agents and read and write files on this device.
- 操作：取消 / Cancel，允许 / Allow。守护进程确认成功后再关闭弹窗；失败时保留弹窗并显示错误，开关保持关闭。

关闭开关不需要确认。其他设备上已打开的远端 tab 会显示「已关闭」状态。

### 侧边栏

- 没有可用设备：只有一个 **对话流 / Conversations** 入口，保持不变。
- 有一台或多台可用设备：先显示 **对话流（本地）**，再为每台设备显示 **对话流（{设备名}）**。「可用」指登录同一账号、当前已连通，并且开启了设备互联。同一台机器上的其他 profile（例如 Canary）是独立设备，也会出现。
- 入口复用 `NAV_ITEM_CLASS_NAME` 和对话流的路由图标，不新增徽标、颜色或说明。设备名过长时截断；悬停时仍能认出选中项。
- 选中状态：现有 `isNavActive` 按前缀匹配，会让「对话流（本地）」在 `/conversations/devices/…` 下同时高亮。本地入口改为排除 `/conversations/devices/` 前缀，设备入口精确匹配自己的路径。
- 设备变为不可用时，入口从侧边栏消失。已打开的 tab 保留，并显示断线状态。

### 远端 tab

- 标题为 **对话流（{设备名}）**；图标与其他 tab 一样，由路由推导。
- 路由：`/{slug}/conversations/devices/{peerId}`。设备必须放在 pathname 中：tab 去重只看 pathname（`tab-store.ts`），`?session=` 等查询参数属于 tab 内的视图状态。
- tab 内容与现有对话流完全一致，不做任何改变。区别只在数据来源和执行位置：都换成远端设备。
- 远端操作归属：

| 操作 | 行为 |
| --- | --- |
| 添加目录、修改会话目录、选择预览文件（`local-v2:choose` 的三种 purpose） | 入口不变，点击后用 Dialog 列出远端设备上的目录或文件：「选择 {设备名} 上的文件夹」/ Choose a folder on {device}。不使用原生选择器。 |
| 点击文件路径、文件树、图片和文档预览 | 从远端设备读取。 |
| 消息中的附件、会话图片 | 通过文件协议从远端读取。 |
| 在输入框添加附件 | 发送前先上传到远端设备。 |
| 文件右键菜单 | 隐藏「在 Finder 中显示」和「打开」，提供「保存到本机」。 |
| 网页预览、Side 浏览器 | 公网地址照常打开，预览实例按设备隔离。回环地址（`localhost`、`127.0.0.1`、`[::1]`）不打开，提示「这是 {设备名} 上的本地地址」。 |
| 智能体打开 Side 会话、文件 tab | 照常在远端 tab 的右侧工作区打开。 |
| 账号或工作区设置确认 | 在发起这轮运行的设备上确认，弹窗标明来自哪台设备，用这台设备的登录凭据应用到云端。 |
| 智能体控制 Side 浏览器 | 在发起这轮运行的设备上执行。 |
| 设备设置（读写偏好、快捷键、守护进程和更新操作） | 拒绝：「这项设置只能在 {设备名} 上修改」。 |
| 导出开发者日志 | 第一版不支持。 |

- 异常提示复用现有的 `LocalRuntimeNotice`，位置和样式不变，只补充远端设备的文案。连接正常时不显示。

| 状态 | 错误码 | zh-Hans | en |
| --- | --- | --- | --- |
| 正在重连 | `device_unreachable` | 与 {设备名} 的连接已断开，正在重连 | Lost connection to {device}. Reconnecting… |
| 被访问端准备中 | `host_not_ready` | {设备名} 正在准备，稍后自动重试 | {device} is getting ready. Retrying shortly… |
| 被访问端已关闭 | `device_link_off` | {设备名} 已关闭设备互联 | {device} turned off Device link |
| 版本不一致 | `incompatible` | 两台设备的 Multica 版本不一致，更新后再试 | Update Multica on both devices to the same version |
| 服务端不一致 | `api_url_mismatch` | {设备名} 连接的是另一个 Multica 服务端 | {device} is connected to a different Multica server |
| 中继下的大文件 | `relay_transfer_limited` | 当前经中继连接，暂不能传输大于 5 MB 的文件 | Files over 5 MB are unavailable while connected through the relay |

断线期间保留已加载内容和草稿，不把正在运行的任务标记为失败。连接恢复前禁用发送。重连后按 `after_seq` 续传，或重新读取快照；待处理的设置确认和 Side 控制在宽限期内保持有效。被访问端更新时进入 drain，期间发起执行返回 `draining`，复用现有文案。

## 能力归属原则

每项能力按它作用于哪台机器划分：

- **机器**：会话数据、执行、文件、目录、执行环境、端口。实现放在守护进程（`server/internal/localconversation`）。本地 tab 经回环访问，远端 tab 经 p2p 访问，只有一份实现。
- **查看端**：窗口、弹窗、确认、网页渲染、保存到本机。实现留在 Electron，由发起请求的那台查看端处理。

host request 只保留需要人操作的请求。今后新增涉及机器数据的能力，写在守护进程中，不写进 Electron 主进程，否则每项能力都要为远端 tab 单独补一次。

## 数据链路

```text
MacBook（查看端）                                         Mac Studio（被访问端）
渲染进程  设备专属 LocalV2Transport（context 注入）
  → IPC local-v2:request / send (deviceId, scope, …)
Electron 主进程  按 deviceId 选择 LocalV2Proxy
  → 回环 HTTP/WS /local/devices/{peerId}/local/v2/...（校验本机 token）
本机守护进程  ReverseProxy，删除 Authorization，去掉 /local/devices/{peerId} 前缀
  → p2p.Dial(peerId, /multica/local-api/1)  ══优先直连══▶  p2p.Listen
                                                          V2.ServeRemote
                                                            → localconversation service
```

Desktop 与守护进程之间的 `/local/v2` 原样承载在 p2p 流上的 HTTP 中。版本检查、WebSocket、按 seq 续传、文件 Range 读取和上传都直接复用。

### 0. 设备发现

1. 守护进程向 p2p-server 登记公钥和地址（含中继地址），并拉取同账号设备生成 allowlist。
2. 连接顺序：局域网 mDNS 或直连，失败时经中继，之后尝试 DCUtR 打洞升级为直连。
3. 被访问端打开开关后注册 `/multica/local-api/1`，通过 identify 推送给其他设备。
4. 查看端 `GET /local/devices` 返回 allowlist 中已连接且支持该协议的设备：`{ peerId, deviceName, connection: direct | relayed }`。Electron 在窗口聚焦时每 5 秒轮询一次，更新侧边栏。

### 1. 握手

```text
打开远端 tab → 主进程为该设备获取 LocalV2Proxy(base=/local/devices/{peerId})，引用计数 +1
 → GET …/local/v2/hello      版本不一致 → incompatible
 → 请求和 WS 带 scope 请求头（API origin、userId、workspaceId）
       被访问端 scope()：userId ≠ .desktop-user-id → account_mismatch
                        API origin ≠ 被访问端 ServerBaseURL → api_url_mismatch
 → WS …/local/v2/ws          服务端分配 client_id 并在第一条消息中返回
 → subscribe_scope {after_scope_seq}；打开会话时 subscribe {after_seq, store_generation}
```

### 2. 读取和执行

```text
渲染进程 LocalV2ScopeClient.request(method, path) → transport(deviceId)
 → IPC local-v2:request(deviceId, …) → proxy(deviceId) → HTTP
 → 隧道 → ServeRemote → V2.ServeHTTP → service → 原路返回
命令（send、interrupt、queue_update…）带 client_id，被访问端记在 turn 上，供第 5 节路由
```

### 3. 实时更新

```text
service 提交事件 → hub 按订阅分发（每个订阅 4 MiB 缓冲，超出则 resubscribe）
 → WS conversation.events / scope.summaries → 隧道 → 查看端 proxy
 → IPC local-v2:message(deviceId) → 渲染进程按 seq 应用
```

v2 推送的是事件本身（含流式文本），不需要「changed → 重新读取」，也不需要在隧道上额外合并。

### 4. 文件

```text
读取：multica-local-file://local/v2/file?deviceId=…&target=/attachments/{id}|/sessions/{id}/image?path=…|/preview/content?…
 → protocol.handle 按 deviceId 选择 proxy → proxy.file（Range 透传）→ 被访问端 serveLocalFile
上传：multica-local-file://local/v2/attachments?deviceId=… → POST …/local/v2/attachments → 附件 id
保存到本机：IPC local-v2:save-file(deviceId, scope, target) → 主进程 showSaveDialog → proxy.file 流式写入本机文件
仅经中继时：读取超过 5 MB（按 Content-Length）或上传超过 5 MB → relay_transfer_limited
```

### 5. 反向请求

```text
被访问端执行中需要查看端（settings.confirm、settings.host、settings.refresh、side.control、developer_logs.export）
 → service.askHost(scope, turn, kind) → hosts.request 优先发给 turn 记录的 client_id 对应的连接
 → 隧道 → 查看端 proxy(deviceId) → 远端 host 处理函数（第 ③ 类）→ host.reply → 隧道 → service 继续
```

现在 `hosts.request` 发给该 scope「最后一次 subscribe 的连接」。远端和本机同账号同工作区，属于同一个 scope，所以 B 设备发起的运行可能把确认弹到 A 上。改为按 turn 的发起连接路由，找不到时才使用现有规则。

### 6. 目录和文件选择

```text
本地 tab：local-v2:choose → 原生选择器 → 主进程 POST /folder-projects | /preview/roots | set_directory（不变）
远端 tab：渲染进程远端选择 Dialog
     每层目录：GET …/local/v2/directories?path= → { path, parent, entries: [{ name, path, kind }] }
 → IPC local-v2:choose-remote(deviceId, scope, request, path) → 主进程按 purpose 发出同样的 POST
```

`isLocalV2RendererPost` 禁止渲染进程直接提交这三类路径，保证路径是用户亲手选的。远端没有原生选择器，路径来自渲染进程的 Dialog，这条约束在远端变弱。第一期在同账号信任下接受；`choose-remote` 只接受远端 deviceId，本地 tab 仍只能走原生选择器。

### 7. 断线、迁移到直连和恢复

```text
p2p 断开 → WS 关闭 → proxy connection(false) → 「正在重连」
 → 该 client_id 的待处理 host request 保留 60 秒
 → libp2p 重新连接 → proxy 退避重连 WS（带原 client_id）→ 渲染进程重新订阅（after_seq）
     宽限期内的 host request 重新下发给新连接
     after_seq 仍可续传 → 补发事件；store_generation 变化或超出 → snapshot_required，重新读取快照
中继升级为直连 → 查看端守护进程关闭走中继的隧道流 → proxy 立即重连（不显示断线提示），新流走直连
被访问端关闭开关 → 移除协议并断开远端连接 → device_link_off → 下次轮询时侧边栏入口消失
关闭最后一个该设备的 tab → 引用计数归零，60 秒后关闭 proxy
```

## 优先直连

- 直连顺序：局域网 mDNS → 登记的直连地址（含 NAT 端口映射和观察到的公网地址）→ 中继，随后 DCUtR 打洞。
- 建立隧道前：如果到该设备只有中继连接，`p2p.Dial` 最多等待 5 秒，等打洞得到直连后再开流；超时才使用中继。
- 打洞成功后：守护进程订阅连接事件，出现非 circuit 连接时，关闭这台设备上所有走中继的隧道流（包括 HTTP 连接池里的空闲连接），proxy 立即在直连上重建 WebSocket。libp2p 新开流时优先选择直连。
- 仍然只有中继时：会话读写照常；单个文件读取或上传超过 5 MB 时返回 `relay_transfer_limited`。
- `/local/devices` 返回 `connection`，并写入诊断日志，便于统计中继占比。侧边栏不显示连接类型。

## 能力清单

远端 tab 涉及的全部读写，按链路分为六类。

### ① `/local/v2` 请求：自动经隧道

| 类别 | 接口 |
| --- | --- |
| 配置和环境 | `GET /providers`、`/models`、`/usage` |
| 目录 | `GET/POST /folder-projects`（POST 只经主进程）、`GET /directory-source`，新增 `GET /directories` |
| 会话 | `GET/POST /sessions`、`GET /sessions/{id}/snapshot`、`POST /sessions/{id}/commands` |
| 队列和 Side | `GET /sessions/{id}/queue`、`GET /sessions/{id}/side-workspace` |
| 相关文件 | `GET /preview/locate|list|file|content`、`POST /preview/roots`（只经主进程）、`GET /sessions/{id}/image` |
| 附件 | `POST /attachments`、`GET /attachments/{id}` |
| 导入 | `GET/POST /imports`、`POST /imports/cancel`（导入被访问端本机的 Claude/Codex 历史） |
| 实时 | `GET /ws` |

远端禁止：`/drain`、`/undrain`、`/stop-providers`（被访问端本机的更新流程）。

### ② 文件：经主进程的协议

`multica-local-file://` 的 URL 带上 `deviceId`，主进程据此选择 proxy。路径白名单沿用 `isLocalV2FilePath`。

### ③ 反向请求：由查看端的 proxy 按设备处理

| kind | 本地 proxy | 远端 proxy |
| --- | --- | --- |
| `side.control` | 现有处理 | 照常处理，预览 owner 带 deviceId，`side_workspace_sync` 的 reconcile 按设备进行；回环地址拦截 |
| `settings.confirm` | 现有处理 | 照常确认，弹窗标明来源设备；查看端根据 operation 和 input 重新生成 `apply`，不直接执行被访问端给出的 `apply` |
| `settings.refresh` | 现有处理 | 照常处理 |
| `settings.host` | 现有处理 | 按 operation 分流：界面类（`settings_assert_scope`、`settings_cancel`、`settings_capabilities`、`settings_open`）照常处理；设备类（`settings_read_device`、`settings_update_device`、`settings_set_shortcut`、`settings_device_action`）拒绝，提示只能在该设备上修改 |
| `developer_logs.export` | 现有处理 | 拒绝 `unsupported_host_request` |

不需要确认的写操作和读取由被访问端守护进程直接调用云端（`settings/tools.go`），不经过查看端。

### ④ Electron 主进程直接操作本机的能力

| 能力 | 归属 | 远端 tab |
| --- | --- | --- |
| 目录和文件选择（`local-v2:choose`） | 界面，路径属于机器 | 新增 `local-v2:choose-remote`，见数据链路第 6 节 |
| 文件右键菜单（`local-file-context-menu`） | 机器和界面，无法跨机 | 改为「保存到本机」（新增 `local-v2:save-file`，`file:download-url` 只放行 http(s)，不复用） |
| 网页预览（`resource-preview`）、Side 浏览器 | 渲染在查看端 | owner 带 deviceId；回环地址拦截 |
| 开发者日志导出 | 守护进程日志属于机器，Web 日志属于查看端 | 第一版不提供 |

### ⑤ 查看端本地状态：key 加 deviceId

| 状态 | 位置 |
| --- | --- |
| scope client | `LocalV2ScopeClient` 的缓存实例（含会话列表、订阅和游标） |
| 输入框草稿 | `composerDraftScope` |
| GUI 偏好（模型、权限模式、推理强度等） | `storage.read/write` 的 `local-provider:` 前缀 |
| 待发送队列 | `desktop-pending-store` |
| 右侧工作区布局 | `local-side-workspace` 的 localStorage |
| 列表布局、项目可见性 | `useConversationLayoutStore`、`useProjectVisibilityStore` |
| Query 缓存 | 本地对话相关的 query key，以及 `resource-folder`、`resource-file` 等单独拼接的 key |
| 网页预览实例 | `resource-preview` 的 owner |

### ⑥ 云端数据：直连

工作区、智能体、任务引用、云端聊天等，两台设备同一账号，查看端直接请求云端。例外：云端任务的 `chat_session_id` 可能指向其他设备上的会话（`agent-task-panel.tsx`）。打开链接时先在本地查找；找不到时依次在可用设备上读取快照，找到则打开对应设备的 tab；都找不到时提示「这个会话在其他设备上」。

## 实现

### 守护进程（Go）

- `p2p` 包：
  - 新增 `Service.Listen(proto) net.Listener` 和 `Service.Dial(ctx, peer, proto) net.Conn`，基于 `Service.Handle` 和 `Service.Open`，保留 allowlist 检查。不使用 `gostream`：它的 `Listen` 直接调用 `SetStreamHandler`，绕过 allowlist。适配器需要处理半关闭（参考 gostream 的 `IgnoreEOF`）。
  - `RemoteAddr()` 返回 peer ID。
  - 新增 `RemoveHandler(proto)`。
  - `Dial` 在只有中继连接时最多等待 5 秒直连；新增连接变化订阅，供隧道在出现直连后迁移。
- 开关：
  - 保存在 profile 目录的 `device-link.json`。
  - 回环接口 `GET`/`PUT /local/device-link`。p2p 未启用或守护进程不提供本地对话时返回 `unavailable`。
  - 打开时 `Listen` 并用 `http.Server{Handler: V2.ServeRemote, ReadHeaderTimeout, IdleTimeout}` 服务；关闭时 `RemoveHandler`、关闭 listener、断开远端连接。
- `localhost.V2.ServeRemote`：
  - 不做 `Authorize`（loopback 和 token），访问控制由 gater、allowlist 和开关负责；保留 `scope()` 的账号校验。
  - 只放行 `/local/v2/` 下的路径，拒绝 `/drain`、`/undrain`、`/stop-providers`。
  - API origin 必须等于被访问端的 `ServerBaseURL`，否则返回 `api_url_mismatch`。否则 `EnsureScope` 会为另一个服务端新建 scope，`contextCloud` 也会返回 nil。
  - 仅经中继时，文件读取和上传超过 5 MB 返回 `relay_transfer_limited`。
- 反向请求路由（`v2_host.go`）：
  - WS 握手时分配 `client_id`，重连时客户端带回原 `client_id`。
  - 命令带 `client_id`，service 记在 turn 上；`askHost` 带 turn，`hosts.request` 优先发给该 `client_id` 的连接，找不到时沿用「最后一次 subscribe 的连接」。
  - 连接断开时，该 `client_id` 的待处理请求保留 60 秒，同一 `client_id` 重连后重新下发；宽限期结束才返回 `ErrHostUnavailable`。现在 `attach` 的 detach 会立即失败所有待处理请求。
- 新增 `GET /local/v2/directories?path=`：列出被访问端目录，供远端选择使用；本地 tab 不使用。
- 回环接口：
  - 在 health mux 上注册 `/local/devices` 和 `/local/devices/`，并调用 `Authorize`。
  - `GET /local/devices` 返回可用设备。
  - `/local/devices/{peerId}/...`：`httputil.ReverseProxy`，去掉前缀，Transport 的 `DialContext` 使用 `p2p.Dial`，设置 `IdleConnTimeout`；删除 `Authorization`；`FlushInterval: -1`。
  - `ErrorHandler` 返回 v2 的错误格式 `{ error: { kind, message } }`：拨号失败为 502 `device_unreachable`；对端不支持协议为 503 `device_link_off`；不在 allowlist 为 404 `device_unknown`。
- `hello` 的 `capabilities` 增加 `device-link`。

### Desktop 主进程和 preload

- `LocalV2Proxy`：
  - 增加 `basePath`，默认空，远端为 `/local/devices/{peerId}`；`/local/v2${path}` 改为 `${basePath}/local/v2${path}`。
  - 保存服务端分配的 `client_id`，重连时带回；命令请求带上 `client_id`。
  - 错误映射：`device_unreachable`、`device_link_off`、`api_url_mismatch`、`incompatible` 更新 availability；只有本机回环接口返回 403 时才重读 token。
  - 远端 proxy 不调用 `drain`、`undrain`、`stopProviders`。
- `DeviceProxies`：`peerId → LocalV2Proxy`，生命周期跟随远端 tab（引用计数），不跟随设备列表；计数归零 60 秒后关闭。远端 proxy 使用远端 host 处理函数（第 ③ 类）。
- IPC 显式带 deviceId 参数（本机为 `"local"`），不从 scope 推断，缺失时报错。涉及 `local-v2:request`、`local-v2:send`、`local-v2:message`、`local-v2:connection`、`local-conversation:availability`、文件协议、`local-file-context-menu`、`side-workspace`、`resource-preview`。
- 新增 `local-v2:choose-remote`、`local-v2:save-file`；设备列表轮询、开关读写的 IPC；`tab:attach`/`tab:detach` 维护引用计数。

### 渲染进程和 views

- 设备专属 transport：`LocalV2Transport` 增加 deviceId 绑定，`LocalV2ScopeClient` 按 `(deviceId, scope)` 缓存。`LocalConversationFlowPage` 从路由读取 deviceId，通过 context 提供；子组件通过 hook 获取，拿不到时抛错，不回落到本机。替换现有直接引用 `window.desktopAPI.localConversations` 的位置：`local-conversation-flow.tsx`、`local-resource-preview.tsx`、`local-runtime-notice.tsx`、`local-side-workspace.tsx`、`side-workspace-bridge.tsx`、`use-local-v2-conversation.ts`。
- `LocalConversationScope` 不增加字段。第 ⑤ 类的 key 改为显式带 deviceId。
- 路由 `/{slug}/conversations/devices/{peerId}`；`paths.ts` 增加对应路径函数。
- `app-sidebar` 增加平台插槽，由 Desktop 注入「对话流（本地）」和「对话流（{设备名}）」，并按上文规则判断选中状态。
- 远端目录和文件选择 Dialog；设置「设备互联」tab 和 AlertDialog；`LocalRuntimeNotice` 按设备订阅并补充远端文案；翻译（en、zh-Hans、ja、ko）。
- 云端任务会话链接的跨设备查找。

## 安全边界

| 层级 | 检查 |
| --- | --- |
| 查看端回环接口 | 现有 token、只允许 loopback Host、不能带 Origin |
| 转发前 | 删除本机 token |
| p2p 连接 | gater 只放行同账号设备，基于握手时证明的公钥身份 |
| 被访问端入口 | 开关打开才注册协议；路径白名单；禁止 drain 和停止 provider；每次请求校验 userId 和 API origin |
| 被访问端执行环境 | 使用被访问端守护进程自己的环境，远端不能传入 env |

已知风险（第一版接受）：

- 信任范围是「同一账号」。p2p-server 接受任何能通过 `/api/me` 的 token（包括 `mat_` 智能体任务 token 和 PAT），开关也只受本机 loopback token 保护。某台机器上被注入的智能体可以注册伪设备并打开开关，从而在该账号的其他已开启设备上执行任务和读取文件。
- 远端选择的目录来自查看端渲染进程，不经原生选择器。

第二期收紧。

## 实施顺序

1. 守护进程：p2p 适配器和直连优先、开关、`ServeRemote`（含 origin 校验）、`client_id` 路由和宽限期、`/directories`、`/local/devices` 和反向代理、错误码。用同一台机器的两个 profile，以 curl 验证 hello、ws、文件。
2. Desktop 主进程和 preload：`basePath`、`client_id`、错误映射、`DeviceProxies` 和引用计数、显式 deviceId 的 IPC、文件协议、`choose-remote`、保存到本机、反向请求和 settings 分流、设备轮询、开关 IPC。
3. 渲染进程和 views：设备专属 transport 和 context、路由、侧边栏插槽和选中规则、第 ⑤ 类 key、远端选择 Dialog、右键菜单和网页预览的远端行为、设置 tab、提示文案、翻译、云端任务会话链接。
4. 验证：
   - Go：适配器（含半关闭）、`ServeRemote` 白名单和 origin 校验、反向代理和错误码、`client_id` 路由（两条连接同 scope 时确认发往发起方）、宽限期、直连迁移。
   - Desktop 主进程：`basePath` 拼接、远端 proxy 不调用 drain、`choose-remote` 拒绝本机 deviceId。
   - 渲染进程：侧边栏两种状态和选中规则、远端 tab、key 隔离、缺少设备 transport 时报错。
   - 手动：先用同一台机器的两个 profile，再用两台不同网络的机器验证打洞和中继回退。浅色和深色主题截图保存在 `.tmp/device-link/`。

## 第二期

- 收紧信任：p2p-server 只接受 Desktop 和守护进程的登录 token；被访问端按设备逐台批准；开关只能从 Desktop 界面修改。
- 端口转发（`/multica/port-forward/1`，只转发被访问端的回环端口），支持预览被访问端的 dev server。
- 从被访问端获取守护进程日志。
- 设备列表改为推送。

## 待定问题

- 被访问端是否需要提示「正在被其他设备使用」？
