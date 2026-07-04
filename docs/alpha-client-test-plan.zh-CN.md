# Tachyon Prism Alpha 客户端测试计划

本文覆盖 Tachyon Prism `alpha.15` 的真实客户端测试闭环。Prism 与 Tachyon Core
在真实 VPS 和真实游戏 UDP 加速方面仍处于 alpha 阶段；不要把本文理解为 stable
或完整可用声明。

## 范围

本计划用于安装 Prism、校验下载产物、导入 Xray 订阅、探测本地 Xray HTTP/SOCKS
入站、配置 Tachyon server profile，并收集脱敏日志、截图和诊断文本。

当前 alpha 有意不测试系统代理接管，也不测试 TUN 一键接管。

## 下载并校验 `alpha.15`

1. 从项目 release 页面下载适合当前平台的 Prism `alpha.15` 产物。
2. 从同一个 release 下载 `SHA256SUMS.txt`。
3. 安装前校验产物。

Linux/macOS：

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

Windows PowerShell：

```powershell
Get-FileHash .\Tachyon-Prism-*.exe -Algorithm SHA256
```

把输出的 SHA-256 与 `SHA256SUMS.txt` 中对应条目比较。

当前产物可能尚未签名。在加入 Authenticode 签名和 Apple notarization 前，
Windows SmartScreen 和 macOS Gatekeeper 可能提示风险。

## 安装与首次启动

1. 安装或解压已校验的产物。
2. 启动 Prism。
3. 记录 release 产物或 UI 显示的 Prism 版本/build。
4. 打开 Overview 和 Settings/Core 页面。
5. 确认 alpha 边界：系统代理和 TUN 接管不属于本轮测试内容。

## 导入订阅并选择节点

1. 打开 **Subscriptions**。
2. 从订阅 URL 导入，或粘贴订阅 payload。
3. 选择一个 Xray 节点。
4. 确认 Prism 在 runtime/config 区域显示了选中的节点。

不要把完整订阅 URL、token 或完整节点密钥回传给项目。如需定位问题，只分享协议类型、
传输类型、脱敏主机和可见导入错误。

## Xray 本地 HTTP/SOCKS 探针

1. 在 **Settings > Core > Binaries** 中安装或选择 Xray Core 二进制。
2. 保存并验证生成的配置。
3. 启动 Xray；如果 Tachyon Core 也已配置，可以使用 **Start All**。
4. 从 Overview 运行本地代理探针。
5. 记录 HTTP 和 SOCKS 两个探针结果：状态、延迟和错误文本。

探针只使用 Prism 生成的本地 Xray 入站。它不会启用 OS 系统代理，也不会启用
Tachyon TUN。

## Core Release Diagnostics

在 **Settings > Core > Binaries** 中分别对 Xray Core 和 Tachyon Core 使用
**Diagnose**。

检查相关 release channel 行为：

- `stable`：跳过 GitHub prerelease。如果 Tachyon Core 只有 alpha release，应显示
  清晰的空状态或错误，并提示切换到 `preview`，而不是静默安装 prerelease。
- `preview` / `pre`：允许选择 prerelease。Tachyon Core 仍处于 alpha 阶段时应使用它。

Diagnostics 是只读、no-spawn 操作。它只使用已保存的 runtime settings，并报告 channel、
解析到的 tag、asset、checksum 状态、安装路径、版本状态和 last error。它不会写设置、
生成配置、启动任何 core、执行已安装二进制、启用系统代理或启用 Tachyon TUN。

## 客户端诊断导出

需要向项目回传支持包时，使用 **Settings > Core > Client Diagnostics > Export diagnostics**。

该导出是只读、no-spawn、no-proxy、no-TUN 操作。它只使用当前 Prism UI 状态和已经收集到的诊断结果；不会写入 runtime settings，不会生成配置，不会启动 Xray 或 Tachyon Core，不会执行已安装二进制，不会启用 OS 系统代理，也不会启用 Tachyon TUN。

JSON 支持包包含 Prism 版本/平台、当前 release channel 设置、Core/Xray 配置或托管路径、Core release diagnostics 摘要、订阅组数量、节点数量、协议统计、当前选中节点的脱敏摘要、最近错误，以及最近一次本地代理探针结果（如已有）。

发送前请先检查文件。导出器会脱敏订阅 URL 查询值、UUID、密码、token、private key、PSK 等字段，但不要把完整订阅 payload、完整分享链接、服务器 PSK 或私钥追加到报告里。

## Tachyon Server Profile

创建一个与已部署 Core VPS 匹配的 Tachyon server profile：

- Name：本地标签。
- Address：VPS IP 或域名。
- Port：VPS 上已放行的 UDP 监听端口。
- PSK：从 VPS 的 `tgp.auth.psk` 复制。
- Transport options：除非测试协调者指定 alpha 设置，否则保持默认。

服务端必须为计划测试的游戏 UDP 目标配置明确的 `allowed_targets`。Prism 无法从订阅
节点列表验证服务端 ACL。

不要回传 PSK。截图时请遮住 PSK 字段。

## 游戏模式与手动规则

使用 Steam 扫描建议或手动规则：

1. 打开 **Settings > Rules**。
2. 添加或选择一个 game profile。
3. 确认进程名或可执行文件路径能匹配即将启动的游戏。
4. 本轮 profile 保持 UDP acceleration 启用。
5. 启动前保存并验证配置。

手动规则需要记录进程名、是否设置可执行文件路径，以及游戏是直接启动还是通过 Steam
启动。如有需要，可从路径中脱敏本地用户名。

## 测试边界

本轮 alpha 客户端测试：

- 测试订阅导入、节点选择、Xray 配置生成、本地 HTTP/SOCKS 探针、Core release
  diagnostics、Tachyon server profile、配置验证、启动/停止行为，以及游戏/手动规则匹配。
- 不启用 OS 系统代理接管。
- 不启用 Tachyon TUN 一键接管。
- 不宣称游戏加速已 stable、生产可用或完整。

## 需要回传的输出

请回传：

- OS 版本和架构。
- Prism 产物文件名和 SHA-256 校验结果。
- Prism 版本/build，以及 Tachyon Core/Xray Core 版本或 release tag。
- 脱敏后的订阅导入结果。
- 选中 Xray 节点摘要：协议、传输方式、脱敏主机/区域（如有帮助）。
- 本地 HTTP 和 SOCKS 探针结果：状态、延迟和错误文本。
- Xray 与 Tachyon Core 的 Core release diagnostics 文本。
- Prism 导出的诊断 JSON 支持包；发送前确认其中没有完整订阅或密钥。
- `xray-client.json` 和 `client.json` 的配置验证结果。
- Tachyon server profile 摘要：脱敏地址、UDP 端口、PSK 是否已填写，以及 VPS
  `allowed_targets` 是否已配置。
- Game profile 或手动规则摘要。
- 隐藏密钥后的 Prism 日志、Core/Xray stderr 片段和截图。

不要回传：

- Tachyon server PSK。
- 完整订阅 URL、token 或完整分享链接。
- 私钥、密码、账号 ID 或无关主机清单。
- 会暴露隐藏 token 文本框内容的截图。
