# Tachyon Prism 快速开始

[English](getting-started.md)

## 前置条件

- Windows 10/11、macOS 13+，或带 TUN 支持的 Linux
- 一个代理订阅、单独分享链接，或完整 Xray outbound/config JSON

## 1. 安装 Tachyon Prism

从 GitHub Releases 下载适合当前平台的 Prism 安装包，然后运行安装程序。

## 2. 导入订阅

1. 打开 Prism，进入 **订阅** 页面。
2. 填写订阅名称和订阅地址后点击 **更新**，也可以粘贴订阅内容后点击 **导入**。
3. 在节点列表中选择一个节点。选中的节点会决定 Xray outbound 和 Tachyon/TGP relay 端点。

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

Windows 上 Prism 还会检查 Tachyon Core 所需的 `wintun.dll` sidecar。Prism 也会显示当前桌面进程是否具备创建 TUN 设备的权限；启动 Tachyon Core TUN 模式前，请以管理员/root 或等效网络权限运行 Prism。

## 6. 生成、验证并保存配置

进入 **设置 > 核心**，找到 **配置草稿**：

- Prism 会根据当前节点、游戏配置、启动器设置和运行端口生成 `xray-client.json` 与 `client.json`。
- 点击 **保存** 把配置写入 Prism 配置目录。
- 点击 **验证配置**，启动前运行 `xray run -test -config` 和 `tachyon-core validate --config`。
- 也可以把任意一份配置复制到剪贴板。

## 7. 启动核心

使用概览页快捷操作，或 **设置 > 核心** 中的运行按钮：

1. Prism 写入最新配置文件。
2. Prism 使用 Xray 原生测试模式验证 `xray-client.json`。
3. Prism 使用 Tachyon Core 验证器验证 `client.json`。
4. Prism 用 `xray-client.json` 启动 Xray Core。
5. Prism 用 `client.json` 启动 Tachyon Core。
6. 概览页显示两个核心的实时状态。

匹配游戏配置的 UDP 流量会通过 TGP 加速。其他代理流量正常走 Xray。

## 验证运行状态

- **概览** 页面会显示运行状态、已启用游戏规则和双核心流量曲线。
- **就绪检查** 会提示缺失的节点、二进制、配置或 sidecar。
- 启动 Tachyon Core 前，**TUN Privilege** 行应显示 `ready`。
- 本地 HTTP 代理探测会通过生成的 Xray HTTP inbound 验证代理链路，不会修改系统代理，也不会启用 TUN。
- 系统代理和 TUN 只建议在你准备接管系统流量时再启用。
