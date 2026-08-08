# Tachyon Prism 快速开始

[English](getting-started.md)

## 前置条件

- Windows 10/11、macOS 13+ 或 Linux
- 一个代理订阅或单独分享链接；也可准备一份本地可信的完整 Xray 配置
- Linux 需要正在运行的 freedesktop.org Secret Service 提供程序，例如 GNOME Keyring，
  或提供 Secret Service API 的 KWallet 环境。

## 1. 安装 Tachyon Prism

从 GitHub Releases 下载适合当前平台的 Prism 安装包，然后运行安装程序。

Windows Credential Manager 与 macOS Keychain 由操作系统提供。Linux 用户需要在启动
Prism 前安装并启动 Secret Service 提供程序；GNOME 等桌面环境通常会自动启动，精简窗口
管理器或无头会话可能需要自行启动 `gnome-keyring-daemon` 或等价服务。凭据服务不可用时，
Prism 会按设计 fail-closed：订阅及其他敏感设置不会降级为明文持久化。

## 2. 导入订阅

1. 打开 Prism，进入 **订阅** 页面。
2. 填写订阅名称和订阅地址后点击 **更新**，也可以粘贴订阅内容后点击 **导入**。
3. 在节点列表中选择一个节点。选中节点会决定 Xray outbound；Tachyon 游戏加速配置仍由 Tachyon 服务器档案独立管理。

远程订阅只提供节点。即使订阅响应包含完整 Xray 配置，Prism 也只抽取已识别 outbound，并丢弃其顶层控制字段。需要使用本地编写的完整配置时，请进入 **设置 > 核心 > 高级 Xray JSON**，启用高级模式并确认安全提示；内容变化或重新导入后必须再次确认。

## 3. 扫描 Steam（可选）

1. 进入 **设置 > 规则**。
2. 点击 **扫描 Steam**，Prism 会自动检测本机 Steam 库目录。
3. 检查建议的游戏配置，点击 **添加** 把需要加速的游戏加入游戏模式。

## 4. 手动添加游戏配置

进入 **设置 > 规则**，添加手动配置：

- **显示名称**：游戏标签。
- **进程名**：可执行文件名，例如 `cs2.exe`。
- **可执行路径**：游戏可执行文件完整路径，可选。

至少需要一个匹配规则。UDP 默认走 Tachyon/TGP 游戏加速。

## 5. 安装核心二进制

进入 **设置 > 核心**，滚动到 **核心文件**：

1. 为每个核心选择 `stable` 或 `preview` 发布通道。
2. **安装最新版 Xray** 会下载、SHA-256 校验并解压最新版 Xray Core。
3. **安装最新版 Tachyon Core** 对 Tachyon Core 执行同样流程。
4. 点击 **使用托管**，让运行路径指向 Prism 管理的二进制文件。
5. 使用 **Diagnose** 查看已保存发布通道、解析到的 tag、资产、checksum、安装路径、
   版本状态和最近错误；它不会写设置、启动核心、执行已安装二进制，也不会启用系统代理
   或 TUN。

`stable` 只使用正式 release；如果 Tachyon Core 暂无正式 release，Prism 会显示清晰空状态并提示切换到 `preview`。`preview` 会优先选择 prerelease，例如 alpha 构建。

Windows 上 Prism 还会检查 Tachyon Core 所需的 `wintun.dll` sidecar。Prism 也会显示当前桌面进程是否具备创建 TUN 设备的权限，但当前 alpha 禁用 TUN 接管；仅运行 Xray 或可选 Tachyon 游戏加速不需要管理员/root 权限。

## 6. 生成、验证并保存配置

进入 **设置 > 核心**，找到 **配置草稿**：

- Prism 会根据当前节点、Tachyon 服务器档案、游戏配置、启动器设置、运行端口、TGP 本地绑定地址、连接迁移和多路径开关生成 `xray-client.json` 与 `client.json`。
- 显式游戏服务器 CIDR 会单独写入 `client.tun.game_routes`。空列表明确表示 Core 不安装
  游戏目的路由。配套 Core 目前只在 Windows 支持非空选择性路由；Linux/macOS 会在创建
  TUN 前 fail-closed，直到具备等价事务能力。
- 点击 **保存** 把配置写入 Prism 配置目录。
- 点击 **验证配置**，启动前运行 `xray run -test -config` 和 `tachyon-core validate --config`。
- 也可以把任意一份配置复制到剪贴板。

当前 alpha 始终强制 `client.tun.auto_route=false` 和 `client.tun.dns_hijack=false`，不会启用系统级 TUN 接管。

## 7. 启动核心

使用概览页快捷操作，或 **设置 > 核心** 中的运行按钮：

1. Prism 写入最新配置文件。
2. Prism 使用 Xray 原生测试模式验证 `xray-client.json`。
3. Prism 使用 Tachyon Core 验证器验证 `client.json`。
4. Prism 执行 Core preflight；`SELECTIVE_ROUTES_SUPPORTED` 错误会阻止游戏加速。旧 Core
   若不支持 preflight，则在 `game_routes` 非空时同样 fail-closed；空列表仍保留仅验证兼容路径。
5. Prism 启动 Xray Core，并等待本地 Xray readiness。
6. 只有 Xray 就绪后才启动 Tachyon Core，然后等待本地 Core `/v1/health` readiness。
7. 任一启动或 readiness 失败都会回滚 **Start All** 本次已经启动的核心。
8. 概览页显示两个核心的实时状态。

匹配游戏配置的 UDP 流量可以通过 TGP 加速。其他代理流量正常走 Xray。

## 验证运行状态

- **概览** 页面会显示运行状态、已启用游戏规则和双核心流量曲线。
- **就绪检查** 会提示缺失的节点、二进制、配置或 sidecar。
- **TUN Privilege** 行在当前 alpha 中只是只读提示，不是启动门槛。
- 本地 HTTP/SOCKS 代理探针会通过生成的 Xray 本地入站验证代理链路，不会修改系统代理，也不会启用 TUN。
- Windows 系统代理控制已经在 UI 中实现为 alpha WinINet 事务，包含快照、验证、恢复和崩溃恢复；尚未完成真实宿主注册表验收，因此还不能视为生产可用。
- macOS 和 Linux 系统代理不受支持。
- TUN 一键接管仍保持禁用，并且是 stable 门禁，不是本轮强制开启内容。
- 真实 VPS、真实客户端和真实游戏 UDP 加速链路仍需实测。
