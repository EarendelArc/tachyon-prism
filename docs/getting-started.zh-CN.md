# Tachyon Prism 快速上手

[English](getting-started.md)

## 前置条件

- Windows 10/11、macOS 13+ 或支持内核 TUN 的 Linux
- 一个代理订阅（VLESS、VMess、Trojan、SS 或完整 Xray JSON）

## 1. 安装 Tachyon Prism

从 GitHub releases 页面下载适合你平台的最新 Prism 版本。运行安装程序。

## 2. 导入订阅

1. 打开 Prism，进入 **Nodes** 视图。
2. 将订阅 URL 粘贴到输入框并点击 **Update**，或直接粘贴订阅内容并点击 **Import**。
3. 从列表中选择一个节点。选中的节点决定 Xray 出站和 TGP Relay 端点。

## 3. 扫描 Steam（可选）

1. 进入 **Launchers** 视图。
2. 点击 **Scan Steam**。Prism 会自动检测系统上的 Steam 根目录。
3. 查看建议的游戏配置文件，点击 **Add** 将需要加速的添加进来。

## 4. 添加游戏配置文件

进入 **Game Mode** 视图，添加手动配置文件：

- **Display name**：游戏标签。
- **Process name**：可执行文件名（如 `cs2.exe`）。
- **Executable path**：游戏可执行文件的完整路径（可选）。

至少需要一条匹配规则。UDP 默认使用 TGP（游戏加速）。

## 5. 安装二进制文件

进入 **Runtime** 视图，滚动到 **Binaries** 区域：

1. **Install Latest Xray**：下载、SHA-256 校验并解压最新 Xray Core release。
2. **Install Latest Tachyon Core**：同样操作 Tachyon Core。
3. 点击 **Use Managed** 将运行时路径指向已安装的二进制文件。

在 Windows 上，Prism 还会检测所需的 `wintun.dll` sidecar。

## 6. 生成并保存配置

进入 **Config** 视图：

- Prism 根据你选中的节点、游戏配置文件和启动器设置生成 `xray-client.json` 和 `client.json`。
- 点击 **Save** 将它们写入 Prism 配置目录。
- 也可以点击 **Copy** 将任一配置复制到剪贴板。

## 7. 启动核心

进入 **Runtime** 视图，点击 **Start All**：

1. Prism 写入最新的配置文件。
2. Prism 用 `xray-client.json` 启动 Xray Core。
3. Prism 用 `client.json` 启动 Tachyon Core。
4. 仪表板实时显示两个核心的状态。

匹配你配置文件的游戏 UDP 流量将通过 TGP 加速。所有其他流量正常走 Xray。

## 验证

- **Overview** 视图显示运行时状态和已启用的游戏配置文件。
- **Runtime** 视图显示每个核心的进程状态（running/stopped）。
- **Readiness** 面板标记缺失的二进制文件、配置或 sidecar。
