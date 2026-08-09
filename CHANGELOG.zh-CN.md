# 更新日志

Tachyon Prism 的重要变更记录于此。历史版本详情可对照英文
[`CHANGELOG.md`](CHANGELOG.md)；从当前未发布版本开始，两份日志同步维护。

## [未发布]

### 新增
- 新增仅接受已签名 annotated tag 的不可变预发布管线。
- 固定六个平台目标、七个安装包、十三个 GitHub 资产和十二条 SHA-256
  记录，并新增机器可读的 `RELEASE_INDEX.json` 与 `RELEASE_MANIFEST.json`。
- 新增 Ubuntu/Windows 双轮元数据可复现性验证，以及发布后的摘要、大小、
  目标提交、预发布标记和 immutable 状态独立校验。

### 验证
- 第一次 GitHub Release 写操作前必须验证 immutable releases、`main` 的严格
  `Required CI gate` 规则和不可移动的 `refs/tags/v*` 规则。

### 保留边界
- `core-contract.json` 仍固定 `v0.1.0-alpha.22`；只有 Core alpha.24 实际发布并
  通过不可变资产验收后才允许升级。
