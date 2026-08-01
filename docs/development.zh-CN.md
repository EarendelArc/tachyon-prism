# 开发

[English](development.md)

## 工具链

Tachyon Prism 使用 `mise` 管理仓库固定的 Node.js 与 Rust 工具链。运行基础检查前，
先安装固定版本的工具与依赖：

```bash
mise install
npm install
npm run typecheck
npm test
npm run test:core-contract
```

工具链与依赖升级必须是明确操作，同时更新相关锁文件，并通过完整的本地与 CI 测试矩阵。
不能仅凭开发主机上的一次成功构建推断平台支持。

## Core 契约

`npm test` 会排除全部 `*.live.test.ts` 文件。跨仓 Core 契约必须通过
`npm run test:core-contract` 显式运行。CI 与 Release 会在 Linux、macOS 和 Windows
上使用 [`core-contract.json`](../core-contract.json) 中的精确源码固定版本执行该契约。

当前已审计固定版本为 Tachyon Core annotated tag `v0.1.0-alpha.22`，tag object 为
`65f57643ae5644233033c3a3a7332290ff1ceeb6`，peel 后为 commit
`80d9fb742c025387c1f036da846fc663ed8a7067`。ref 不可用、tag object 不匹配或
peel 后 commit 不匹配都会直接失败。

该契约不会启用 TUN。Linux 和 macOS 会确认真实 Core 进程在报告
`TUN device ready` 前拒绝非空选择性路由；Windows 会解析 `go test -json`，并要求
每个指定的内存路由测试分别产生自己的 run 与 pass 事件。这些检查证明固定版本的配置和
路由契约，不证明真实数据包接管或真实游戏加速。

Prism 负责生命周期编排与界面呈现，Tachyon Core 负责 TGP 传输，Xray 负责普通代理传输。
渲染器不得实现数据包路由决策。

## 桌面 UI 门禁

`npm run test:ui` 会使用专用 `ui-smoke` 模式构建渲染器，并在隔离的 800x540 Edge
环境中运行冒烟测试。它验证订阅状态本地化、插件按需安装、可见的自定义滚动条、外观设置
持久化、四条非零流量曲线，以及迁移与重载行为。

生产安全存储依赖操作系统凭据服务，而纯浏览器冒烟环境有意不提供该能力。只有
`ui-smoke` 构建会替换为本地测试 vault；测试通过该替身验证迁移语义，但不证明生产
keyring 或加密文件实现。生产后端由 Rust vault 测试覆盖。

在 Windows 上，`npm run test:native-window` 会启动一个已经存在的 Prism 打包可执行文件，
并把 Win32 窗口样式作为硬门禁。它会拒绝 `WS_CAPTION`、`WS_THICKFRAME` 和可见控制台窗口，
同时检查标题栏拖动与自定义窗口控件。该命令不会构建二进制，也不会启用系统代理或 TUN。

这两项桌面门禁都不能替代隔离环境中的系统代理、TUN 或真实服务器端到端测试。

## 安全敏感开发

权威边界与威胁模型见[安全模型](security.zh-CN.md)。修改以下区域时，必须同步增加负向测试
和中英文文档。

### 运行时所有权

系统代理事务仅由受管 Xray 进程持有。Tachyon Core 的启动、停止或失败不得修改该事务。
停止 Xray 前，Prism 会恢复原系统代理快照；如果恢复失败，退出会被阻止，同时保留 Xray
运行，避免系统代理继续指向已停止的本地端口。Tachyon Core 诊断必须和 Xray 诊断一样经过
有长度限制的敏感信息脱敏边界。

### 订阅边界

订阅下载由 Rust 后端执行。它只接受不含内嵌凭据的 HTTP(S) 地址，对每一跳重定向分别执行
解析、DNS 与地址验证，把获批地址绑定到实际连接，拒绝 HTTPS 降级，并阻止云元数据和其他
特殊用途目标。当前产品策略不开放私网或本地订阅端点。不得把订阅获取移到渲染器 `fetch`，
也不得削弱逐跳检查。

### 渲染器边界

打包渲染器的 CSP 只允许应用自身资源与 Tauri IPC；任意远程 HTTP(S)、frame、form、
object 和 `unsafe-eval` 均被阻止。Tachyon 遥测由 Rust 后端轮询并通过 Tauri IPC 交付，
因此渲染器代码不得新增直接回环网络访问。

### 加密 vault

订阅地址与节点、完整 Xray outbound 数据、高级 Xray JSON、Tachyon 服务端配置和 TGP PSK
必须保存在加密 vault 中，不得写入 WebView `localStorage`。后端把随机 256 位主密钥保存在
操作系统凭据服务中，并使用 XChaCha20-Poly1305、全新 nonce、关联数据、原子替换、受限文件
权限以及解密比对验证保护版本化 vault。凭据缺失或验证失败时必须封闭失败，不能回退到明文。

旧值只有在成功写入并验证迁移后才能删除。供两个核心运行的配置文件仍会暂时存在于磁盘，
必须使用受保护文件写入器。非敏感 UI 偏好可以继续保存在 `localStorage`。

## Core preview 固定版本

当前审计目标是已经发布的 Tachyon Core annotated preview tag `v0.1.0-alpha.22`，
tag object 为 `65f57643ae5644233033c3a3a7332290ff1ceeb6`，peel 后 commit 为
`80d9fb742c025387c1f036da846fc663ed8a7067`。这是明确的已发布 preview 契约，
不表示 Prism 自动跟随最新 Core。升级必须等待更新版本正式发布并通过同等契约审查；
不得预填未发布 commit 或臆测未来 Release SHA。

## UI 证据与跨平台构建

`npm run test:ui:twice` 要求工作树干净且最终 Prism 可执行文件已经构建。命令会运行
两轮隔离 UI smoke，并在 `artifacts/ui-smoke-runs/` 生成适合 CI 上传的不可变证据结构。
renderer 与 native build 证据会严格分层：`RENDERER_EVIDENCE_MANIFEST.json` 只绑定
精确 Git commit、两轮子 `RESULT.json` 和确实由 Vite/Edge renderer fixture 生成的截图；
`NATIVE_BUILD_MANIFEST.json` 只绑定已构建但未执行的最终可执行文件。汇总索引会明确说明
native EXE 没有生成 renderer 截图，也不会在 Windows UIPI 或“不干扰交互用户”约束阻止
自动化时虚假声明原生 L2 输入通过。

manifest 哈希读取会拒绝路径中任何 symlink 或 Windows reparse 分量，在系统支持时使用
no-follow 打开语义，仅通过一个文件描述符计算哈希，并在读取后重新核对描述符和路径
identity。文件替换或原地修改都会使证据生成失败。

全局路由 smoke 会在内存中规范化并比较完整的已选与生成后 Xray outbound 对象，认证字段
同样参与比较，再使用临时随机密钥计算 HMAC。RESULT 只写入 HMAC 与公开去敏描述，不会
输出凭据或 HMAC 密钥。

CI 还会在六个受支持的平台/CPU 矩阵项上执行本地 Tauri bundle 构建。这些检查只在
作业内部生成 bundle，不签名、不发布、不上传到 Release，也不会产生发布副作用。

## Cargo Registry

Prism 在 `.cargo/config.toml` 中使用仓库本地 Cargo source replacement，将 crates.io
替换为 RSProxy sparse registry，以提高中国大陆网络环境下的依赖获取稳定性。该设置不会修改
用户的全局 Cargo 配置。

## Release 构建

Release 工作流定义于 `.github/workflows/release.yml`；完整治理和校验契约见
[发布指南](releasing.zh-CN.md)。工作流会先测试前端、Rust 后端和固定 Core 契约，再构建
Windows x64/ARM64、macOS x64/ARM64 和 Linux x64/ARM64 安装包。

发布流程采用封闭失败：它要求 annotated tag、immutable releases、无 bypass actor 的 active
`refs/tags/v*` 保护规则集、双语发布说明、可复现源码元数据和精确远端摘要校验。最终 Release
契约为七个安装包，加上 `RELEASE_NOTES.md`、`RELEASE_NOTES.zh-CN.md`、
`BUILD_METADATA.json` 和 `SHA256SUMS.txt`，共 11 个资产，清单包含 10 条记录。这个确定性
暂存契约不代表不同签名或打包环境能够生成字节完全一致的安装包。
