import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  buildCoreClientConfigDraft,
  buildXrayClientConfigDraft,
  initializeAdvancedXrayDraftText,
  parseXrayConfigText,
  stringifyDraft,
  type CanonicalXrayLoadState,
  type XrayRoutingMode,
} from "./domain/configDrafts";
import {
  buildClientDiagnosticsExport,
  prismVersion,
  stringifyDiagnosticsExport,
} from "./domain/diagnostics";
import {
  getConfigPaths,
  saveConfigDraft,
  type ConfigDraftPaths,
} from "./domain/desktopConfig";
import type { GameProfile, LauncherSettings } from "./domain/gameProfiles";
import {
  defaultGameProfiles,
  loadLauncherSettings,
  listGameProfiles,
  removeGameProfile,
  saveGameProfile,
  saveLauncherSettings,
  scanSteamLibrary,
} from "./domain/gameProfiles";
import {
  getLatestTachyonCoreRelease,
  getLatestXrayRelease,
  getCoreReleaseDiagnostics,
  buildReleaseDiagnosticsDisplay,
  getManagedBinaries,
  getRuntimePrivilegeStatus,
  getRuntimePaths,
  getRuntimeSettings,
  getRuntimeStatus,
  getSystemProxyStatus,
  getXrayTrafficStats,
  commitValidatedXrayConfig,
  disableSystemProxy,
  enableSystemProxy,
  installLatestTachyonCore,
  installLatestXray,
  installManagedBinary,
  installWintunSidecar,
  preflightTachyonCore,
  readCanonicalXrayConfig,
  saveRuntimeSettings,
  startTachyonCore,
  startXray,
  stopTachyonCore,
  stopXray,
  tachyonCorePreflightFallbackMessage,
  tachyonCorePreflightReadinessMessage,
  tachyonCorePreflightStartBlockReason,
  tachyonIpcBaseUrl,
  testXrayLocalProxies,
  testTcpLatency,
  validateTachyonCoreConfig,
  type ConfigValidationResult,
  type CoreReleaseDiagnostics,
  type ManagedBinaryInfo,
  type ManagedBinaryInventory,
  type ManagedBinaryKind,
  type LocalProxyProbeReport,
  type ProcessStatus,
  type ProxyProbeResult,
  type ReleaseChannel,
  type RuntimePaths,
  type RuntimePrivilegeStatus,
  type RuntimeReleaseInfo,
  type RuntimeSettings,
  type RuntimeStatus,
  type SystemProxyState,
  type TachyonCorePreflightCheck,
  type TachyonCorePreflightResult,
  type TcpLatencyResult,
  type XrayTrafficStats,
} from "./domain/runtime";
import {
  activeSubscription,
  createSubscriptionSnapshot,
  fetchSubscriptionText,
  loadSubscriptionSnapshot,
  parseSubscriptionWithReport,
  removeSubscription,
  saveSubscriptionSnapshot,
  selectSubscription,
  selectSubscriptionNode,
  totalSubscriptionNodes,
  xrayOutboundCompatibilityForNode,
} from "./domain/subscriptions";
import {
  activeTachyonServer,
  draftFromTachyonServerProfile,
  emptyTachyonServerDraft,
  loadTachyonServerSnapshot,
  removeTachyonServerProfile,
  saveTachyonServerSnapshot,
  selectTachyonServerProfile,
  tachyonServerEndpoint,
  upsertTachyonServerProfile,
  type TachyonServerDraft,
  type TachyonServerProfile,
  type TachyonServerSnapshot,
} from "./domain/tachyonServers";
import {
  emptyTrafficSample,
  emptyXrayTrafficStats,
  hasTrafficSource,
  trafficRateSample,
  trafficSeriesFromSamples,
  trafficTotalsFromSources,
  type TrafficSample,
  type TrafficTotals,
} from "./domain/trafficMetrics";
import type {
  ProxyNode,
  SubscriptionParseReport,
  SubscriptionProfile,
  SubscriptionSnapshot,
} from "./domain/subscriptions";
import {
  createTranslator,
  loadLanguage,
  saveLanguage,
  type Language,
} from "./domain/i18n";
import {
  enabledPluginCount,
  emptyPluginState,
  installPluginState,
  installedPluginCount,
  loadPluginState,
  recordPluginRun,
  savePluginState,
  togglePluginEnabled,
  type PluginStateSnapshot,
} from "./domain/plugins";
import { TelemetryClient } from "./domain/telemetry";
import type { TelemetryState } from "./domain/telemetry";
import { invokeDesktop, isTauriRuntime } from "./domain/tauri";

type ConnectionState = "checking" | "connected" | "disconnected";
type PrismView = "overview" | "configs" | "subscriptions" | "plugins" | "settings";
type SettingsSection = "general" | "core" | "rules" | "plugins" | "about";
type ReadinessState = "error" | "ok" | "warning";
type SubscriptionViewMode = "grid" | "list";
type ValidationResults = Partial<Record<ManagedBinaryKind, ConfigValidationResult>>;
type ProbeState = "error" | "idle" | "ok" | "running";
type PluginFilter = "all" | "enabled" | "installed";

interface TimedTrafficSample extends TrafficSample {
  at: number;
}

interface RuntimeStartResult {
  error: string | null;
  ok: boolean;
}

interface StartAllResult {
  runtime: RuntimeStatus;
  confirmation: string;
}

interface StopAllResult {
  runtime: RuntimeStatus;
  proxyRestored: boolean;
  proxyRestoreStatus: string;
  errors: string[];
}

interface XrayProbeStatus {
  error: string | null;
  report: LocalProxyProbeReport | null;
  state: ProbeState;
}

interface XrayAdvancedEditorState {
  enabled: boolean;
  text: string;
}

const prismViews: PrismView[] = ["overview", "configs", "subscriptions", "plugins", "settings"];
const routingModeStorageKey = "tachyon.prism.routingMode.v1";
const xrayAdvancedEditorStorageKey = "tachyon.prism.xrayAdvancedEditor.v1";

interface ReadinessItem {
  detail: string;
  label: string;
  state: ReadinessState;
}

interface TrafficSourceBadge {
  detail: string;
  label: string;
  state: "checking" | "error" | "idle" | "ok";
}

type NodeLatencyMap = Record<string, TcpLatencyResult>;

interface PolicyGroup {
  active: string;
  chain: string[];
  description: string;
  icon: string;
  id: string;
  nodes: ProxyNode[];
  title: string;
  type: string;
}

const emptyProfile = {
  displayName: "",
  processName: "",
  executablePath: "",
};

const emptyRuntimeInputs = {
  tachyonGrpcListen: "127.0.0.1",
  tachyonGrpcPort: 50051,
  tachyonIpcListen: "127.0.0.1",
  tachyonIpcPort: 55123,
  tachyonCoreBinaryPath: "",
  tachyonCoreReleaseChannel: "preview" as ReleaseChannel,
  tachyonFecAdaptWindow: 32,
  tachyonFecDataShards: 4,
  tachyonFecDynamic: true,
  tachyonFecGroupTimeoutMs: 20,
  tachyonFecParityShards: 2,
  tachyonConnectionMigration: true,
  tachyonLocalAddrs: "",
  tachyonMultipath: false,
  tachyonServerAddress: "",
  tachyonTgpAuthPsk: "",
  tachyonTgpServerAddress: "",
  tachyonTelemetryIntervalMs: 500,
  tachyonTunAddress: "198.18.0.1/16",
  tachyonTunAutoRoute: false,
  tachyonTunDnsHijack: false,
  tachyonTunMtu: 9000,
  xrayBinaryPath: "",
  xrayHttpListen: "127.0.0.1",
  xrayHttpPort: 10809,
  xraySocksListen: "127.0.0.1",
  xraySocksPort: 10808,
  systemProxyBypass: "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>",
  xrayStatsEnabled: true,
  xrayStatsListen: "127.0.0.1",
  xrayStatsPort: 10085,
  xrayReleaseChannel: "stable" as ReleaseChannel,
};

const emptyBinarySourceInputs = {
  tachyonCore: "",
  xray: "",
};

const managedBinaryKinds: ManagedBinaryKind[] = ["xray", "tachyonCore"];
const pluginCatalogIds = [
  "rolling-release",
  "node-transform",
  "traffic-stats",
  "smart-node-switch",
] as const;

const zh = {
  activeConnections: "活动连接",
  add: "添加",
  all: "全部",
  addProgram: "添加程序",
  autoSelect: "自动选择",
  cardMode: "卡片模式",
  binaries: "核心文件",
  binaryInventoryUnavailable: "核心清单不可用",
  checksum: "校验和",
  checksumMatch: "匹配",
  checksumMismatch: "不匹配",
  checksumNotChecked: "未校验",
  checkLatest: "检查更新",
  collapseAll: "收起全部",
  configDrafts: "配置草稿",
  configs: "配置",
  configuredPathExists: "配置路径存在",
  configuredPathMissing: "配置路径缺失",
  controller: "控制器",
  coreSettings: "核心",
  coreControl: "核心控制",
  coreStatus: "双核心状态",
  currentNode: "当前节点",
  directMode: "直连",
  directModeDesc: "直接连接所有流量",
  download: "下载",
  diagnose: "诊断",
  diagnoseNote: "诊断仅使用已保存的运行时设置；不会写入文件或启动核心。",
  dependencyMissing: "缺少 {path}",
  enabledProfiles: "启用规则",
  edit: "编辑",
  globalMode: "全局",
  import: "导入",
  install: "安装",
  installed: "已安装",
  installedPath: "安装路径",
  installedVersion: "已安装版本",
  installLatest: "安装最新版",
  installWintun: "安装 Wintun",
  language: "语言",
  latest: "最新",
  launchers: "启动器",
  list: "列表",
  memory: "内存",
  memoryNotExposed: "内存接口待接入",
  metricUnknown: "未知",
  nodeSelector: "节点选择",
  nodes: "节点",
  primaryNavigation: "主导航",
  previewMode: "预览模式",
  overview: "概览",
  plugins: "插件",
  readiness: "就绪检查",
  realTimeTraffic: "实时流量",
  refresh: "刷新",
  remove: "移除",
  rulesMode: "规则",
  rulesModeDesc: "按照规则文件分流",
  runtime: "运行时",
  save: "保存",
  savePaths: "保存路径",
  scanSteam: "扫描 Steam",
  selected: "已选择",
  settings: "设置",
  showUnavailableNodes: "显示不可用节点",
  sortByDelay: "按延迟排序",
  start: "启动",
  startAll: "启动全部",
  startAllComplete: "Xray Core 与 Tachyon Core 已启动",
  startAllFailed: "双核心启动事务失败",
  startAllPartial: "Xray Core {xray} / Tachyon Core {tachyon}",
  runtimeStarted: "已启动",
  runtimeFailed: "启动失败",
  runtimeOnline: "运行中",
  runtimeOffline: "未运行",
  capabilityChecking: "正在检查能力",
  capabilityUnavailable: "能力不可用",
  stop: "停止",
  stopAll: "停止全部",
  stopAllComplete: "Xray Core 与 Tachyon Core 已停止",
  stopAllFailed: "双核心停止事务失败",
  subscriptions: "订阅",
  tachyon: "Tachyon",
  tachyonAdaptiveFec: "TGP 自适应 FEC",
  tachyonAdaptiveFecDesc: "动态冗余调节",
  tachyonFecShards: "TGP FEC 分片",
  tachyonFecTiming: "TGP FEC 时序",
  tachyonConnectionMigration: "TGP 连接迁移",
  tachyonConnectionMigrationDesc: "允许 IP 或网络切换时保持游戏会话",
  tachyonLocalAddrs: "TGP 本地绑定地址",
  tachyonMultipath: "TGP 多路径",
  tachyonMultipathDesc: "同时使用多块网卡发送游戏 UDP",
  tachyonServer: "Tachyon 服务器",
  tachyonServerAddress: "服务器地址",
  tachyonServerName: "服务器名",
  tachyonServerPort: "端口",
  tachyonServerRemark: "备注",
  tachyonServerProfiles: "Tachyon 服务器档案",
  tachyonServerEditing: "正在编辑 Tachyon 服务器",
  tachyonServerRemoved: "Tachyon 服务器已删除",
  tachyonServerSaved: "Tachyon 服务器已保存",
  tachyonServerSelected: "Tachyon 服务器已选择",
  tachyonServerNoRemark: "无备注",
  tachyonServerProfileDesc: "Tachyon 服务器与 Xray 订阅节点独立，保存后用于生成 Core client.json。",
  tachyonTgpAuthPsk: "TGP 共享密钥 PSK",
  tachyonTgpAuthPskDesc: "从 Tachyon 游戏服务器 server.json 的 tgp.auth.psk 复制，至少 16 字符；不要使用 Xray 订阅节点内容",
  tachyonTgpServer: "TGP 服务器",
  tachyonTunAutoRoute: "TUN 全局路由",
  tachyonTunDnsHijack: "DNS 劫持",
  traffic: "流量",
  trafficNoSamplesHint: "启动 Xray 或 Tachyon Core 后，这里会显示真实的双核心流量曲线。",
  trafficSource: "数据源",
  update: "更新",
  updateAll: "更新全部",
  upload: "上传",
  useManaged: "使用托管",
  xray: "Xray",
  aboutDescription: "一个支持 Xray Core 与 Tachyon Core 的跨平台代理 GUI。",
  adminRestart: "以管理员身份运行（重启生效）",
  advancedXrayConfig: "高级 Xray JSON",
  advancedXrayDescription: "直接编辑完整配置；未知字段与未来协议保持原样。保存和启动前会运行 Xray 配置测试。",
  advancedXrayEnable: "使用高级完整配置",
  advancedXrayExport: "导出 JSON",
  advancedXrayExportFailed: "Xray JSON 导出失败",
  advancedXrayImport: "导入 JSON",
  advancedXrayImportFailed: "Xray JSON 导入失败",
  advancedXrayImported: "完整 Xray JSON 已导入",
  advancedXrayRestored: "已恢复上次有效 Xray 配置",
  advancedXrayRestore: "恢复有效配置",
  advancedXrayRestoreGenerated: "恢复生成配置",
  advancedXrayValidated: "Xray 配置已验证并保存",
  canonicalXrayReadFailed: "无法读取上次有效 Xray 配置；当前草稿未更改",
  configSaveFailed: "配置保存失败",
  configValidationFailed: "配置验证失败",
  coreConfigGenerationFailed: "Tachyon Core 配置生成失败",
  coreConfigDraftUnavailable: "没有可用的 Tachyon Core 配置草稿",
  xrayConfigDraftUnavailable: "没有可用的 Xray 配置草稿",
  xrayConfigGenerationFailed: "Xray 配置生成失败",
  xrayJsonValidationFailed: "Xray JSON 验证失败",
  xraySelectNodeRequired: "生成 Xray 配置前请选择订阅节点",
  allowPluginNodeAccess: "允许插件读取节点",
  autoUpdatePlugins: "自动更新插件",
  behavior: "行为",
  checkUpdates: "检查更新",
  color: "颜色",
  copyCore: "复制 Core",
  copyXray: "复制 Xray",
  clientDiagnostics: "客户端诊断",
  clientDiagnosticsDesc: "导出脱敏支持包：只读、no-spawn、no-proxy、no-TUN。",
  diagnosticsNoProxy: "不启用系统代理",
  diagnosticsNoSpawn: "不启动或执行 Core/Xray",
  diagnosticsNoTun: "不启用 Tachyon TUN",
  diagnosticsReadOnly: "不写 runtime settings",
  diagnosticsReviewReminder: "分享前请手动检查导出的 JSON，确认脱敏结果符合预期。",
  diagnosticsExported: "诊断支持包已导出",
  exportDiagnostics: "导出诊断",
  validateConfigs: "验证配置",
  validationFailed: "失败",
  custom: "自定义",
  dark: "深色",
  defaultColor: "默认",
  displayName: "显示名称",
  downloadRate: "下载速率",
  executablePath: "可执行文件路径",
  expand: "展开",
  filter: "筛选",
  fixedWindow: "固定 800 × 540 窗口",
  followSystem: "跟随系统",
  gameMode: "游戏模式",
  globalModeDesc: "仅走 Global 策略组",
  globalBlock: "全球拦截",
  globalDirect: "全球直连",
  green: "绿色",
  grid: "网格",
  leakFish: "漏网之鱼",
  light: "浅色",
  liveTelemetry: "实时遥测",
  localProxyProbe: "本地代理验证",
  more: "更多",
  noNodeSelected: "未选择节点",
  noCompatibleAsset: "没有兼容的发布文件",
  noSubscriptionNodes: "还没有订阅节点",
  noTachyonServerProfiles: "还没有 Tachyon 服务器档案",
  proxyProbeFailed: "本地代理验证失败",
  proxyProbeIdle: "启动 Xray 后测试当前节点的 HTTP/SOCKS 入站",
  proxyProbeNeedNode: "请先选择 Xray 订阅节点",
  proxyProbeNeedRunning: "请先启动 Xray，再测试当前节点",
  proxyProbeOk: "本地代理验证通过",
  proxyProbeRunning: "正在测试本地 HTTP/SOCKS 代理...",
  notConfigured: "未配置",
  notInstalled: "未安装",
  notProbed: "未探测；诊断不会执行已安装的核心",
  pageVisibility: "页面可见性",
  personalized: "个性化",
  policyGroups: "策略组",
  pluginAllowNodeRead: "允许插件读取节点",
  pluginAutoUpdate: "自动更新插件",
  pluginAllInstalled: "已安装并启用全部内置插件",
  pluginCenter: "插件中心",
  pluginDisabled: "已停用",
  pluginEnabled: "已启用",
  pluginInstalled: "已安装",
  pluginLastRun: "最后运行",
  pluginLastResult: "最后结果",
  pluginNeverRun: "未运行",
  pluginNoMatches: "当前筛选下没有插件",
  pluginNoResult: "暂无结果",
  pluginNotInstalled: "未安装",
  pluginRunCompleted: "{title} 运行完成",
  pluginRollingDesc: "提升 Prism 升级体验，获取更快更新通道。",
  pluginRollingApplied: "已切换 Xray 与 Tachyon Core 到预览通道",
  pluginRollingTitle: "滚动发行",
  pluginRunCount: "运行次数",
  pluginSettings: "插件设置",
  pluginSourceBundled: "内置插件，随 Prism 一起发布",
  pluginStatsDesc: "高效流量统计插件，支持按域名、进程聚合。",
  pluginStatsSnapshot: "Xray ↑{xrayUp} ↓{xrayDown} / Tachyon ↑{tachyonUp} ↓{tachyonDown}",
  pluginStatsTitle: "流量统计",
  pluginSwitchNeedLatency: "请先刷新延迟再运行节点智能切换",
  pluginSwitchDesc: "实现动态代理选择机制，包含故障转移。",
  pluginSwitchTitle: "节点智能切换",
  pluginTriggerApp: "APP激活后",
  pluginTriggerManual: "手动触发",
  pluginTriggerNode: "节点变化",
  pluginTriggerUpdate: "更新订阅时",
  pluginTransformDesc: "节点格式转换插件，支持 v2Ray 格式导入。",
  pluginTransformSaved: "已为 {node} 保存 Xray 配置草稿",
  pluginTransformTitle: "节点转换",
  pluginUnknown: "未知插件",
  pluginUpdatesChecked: "内置插件已是最新版本",
  processName: "进程名",
  purple: "紫色",
  quickStart: "快速启动",
  ready: "就绪",
  recentRoutes: "最近路由",
  releaseChannel: "发布通道",
  releaseAsset: "发布文件",
  releasePreview: "预览",
  releaseStable: "稳定",
  resolvedTag: "解析版本",
  refreshLatency: "刷新延迟",
  runProxyProbe: "测试当前节点",
  routeByRule: "按规则和进程自动选择出口",
  ruleSets: "规则集",
  run: "运行",
  scheduledTasks: "计划任务",
  selector: "选择器",
  settingsAbout: "关于",
  settingsGeneral: "通用",
  source: "源码",
  sourceBinaryPath: "源二进制路径",
  disable: "停用",
  enable: "启用",
  steamChildTracking: "Steam 子进程追踪",
  steamLauncherDetection: "Steam 启动器检测",
  steamRoot: "Steam 根目录",
  subscriptionDuplicates: "重复节点 {count}",
  subscriptionImportResult: "已导入 {count} 个节点",
  subscriptionName: "订阅名称",
  subscriptionPayload: "粘贴订阅内容",
  subscriptionSkipped: "跳过 {count} 条",
  subscriptionUnsupported: "不支持协议：{protocols}",
  subscriptionUrl: "订阅地址",
  xrayRetainedOnly: "仅保留，Xray 不支持",
  xraySupported: "Xray 支持",
  xrayUnsupported: "Xray 不支持",
  configFilesSaved: "配置文件已保存",
  configsValidated: "可用配置已验证",
  configsValidationErrors: "配置验证完成，但存在错误",
  labelCopied: "{label} 已复制",
  latencyRefreshed: "延迟已刷新",
  noConfigDraftAvailable: "没有可用的配置草稿",
  noRemoteSubscriptions: "没有可更新的远程订阅",
  nodeSelected: "节点已选择",
  readyAddSubscription: "准备添加订阅",
  routingModeSelected: "{mode} 模式已选择",
  subscriptionRemoved: "订阅已移除",
  subscriptionSelected: "订阅已选择",
  subscriptionsUpdated: "{count} 个订阅已更新",
  subscriptionsUpdatedPartial: "{ok}/{total} 个订阅已更新",
  systemProxy: "系统代理",
  systemProxyEnabled: "由 Prism 接管",
  systemProxyDisabled: "未启用",
  systemProxyNeedsXray: "启动 Xray 后可用",
  systemProxyOtherActive: "检测到其他系统代理",
  systemProxyUnsupported: "当前平台后端不支持",
  theme: "主题",
  totalTraffic: "总流量",
  tunMode: "TUN模式",
  tunRuntimeUnavailable: "runtime 尚未暴露启停能力",
  tunSettingUnavailable: "runtime 尚未暴露该设置；当前配置固定为关闭",
  unavailableInThisBuild: "当前版本禁用，避免影响正在进行的游戏",
  unavailable: "不可用",
  uploadRate: "上传速率",
  urlTest: "URLTest",
  waitingTelemetry: "等待遥测流...",
  liveWindow: "实时窗口",
  openCoreSettings: "打开核心设置",
  xrayStatsActive: "Stats 已连接",
  xrayStatsDisabled: "Stats 已关闭",
  xrayStatsError: "Stats 错误",
  xrayStatsWaiting: "等待 Stats",
  xrayStopped: "Xray 未运行",
  tachyonTelemetryActive: "遥测已连接",
  tachyonTelemetryWaiting: "等待遥测",
  tachyonStopped: "Tachyon 未运行",
  tgpSessions: "TGP 会话",
  workMode: "工作模式",
  windowControls: "窗口控制",
  pinWindow: "置顶窗口",
  minimizeWindow: "最小化窗口",
  maximizeUnavailable: "固定窗口不可最大化",
  closeWindow: "关闭窗口",
};

const en: typeof zh = {
  activeConnections: "Active",
  add: "Add",
  all: "All",
  addProgram: "Add Program",
  autoSelect: "Auto Select",
  cardMode: "Card Mode",
  binaries: "Binaries",
  binaryInventoryUnavailable: "Binary inventory unavailable",
  checksum: "Checksum",
  checksumMatch: "Match",
  checksumMismatch: "Mismatch",
  checksumNotChecked: "Not checked",
  checkLatest: "Check Latest",
  collapseAll: "Collapse All",
  configDrafts: "Config Drafts",
  configs: "Config",
  configuredPathExists: "Configured path exists",
  configuredPathMissing: "Configured path missing",
  controller: "Controller",
  coreSettings: "Core",
  coreControl: "Core Control",
  coreStatus: "Dual-core status",
  currentNode: "Current Node",
  directMode: "Direct",
  directModeDesc: "Direct all traffic",
  download: "Download",
  diagnose: "Diagnose",
  diagnoseNote: "Diagnostics use saved runtime settings only; they do not write files or start cores.",
  dependencyMissing: "Missing {path}",
  enabledProfiles: "Enabled Rules",
  edit: "Edit",
  globalMode: "Global",
  import: "Import",
  install: "Install",
  installed: "Installed",
  installedPath: "Installed path",
  installedVersion: "Installed version",
  installLatest: "Install Latest",
  installWintun: "Install Wintun",
  language: "Language",
  latest: "Latest",
  launchers: "Launchers",
  list: "List",
  memory: "Memory",
  memoryNotExposed: "Memory API not exposed",
  metricUnknown: "Unknown",
  nodeSelector: "Node Selector",
  nodes: "nodes",
  primaryNavigation: "Primary navigation",
  previewMode: "Preview mode",
  overview: "Overview",
  plugins: "Plugins",
  readiness: "Readiness",
  realTimeTraffic: "Realtime Traffic",
  refresh: "Refresh",
  remove: "Remove",
  rulesMode: "Rule",
  rulesModeDesc: "Route by rules",
  runtime: "Runtime",
  save: "Save",
  savePaths: "Save Paths",
  scanSteam: "Scan Steam",
  selected: "Selected",
  settings: "Settings",
  showUnavailableNodes: "Show unavailable",
  sortByDelay: "Sort by latency",
  start: "Start",
  startAll: "Start All",
  startAllComplete: "Xray Core and Tachyon Core started",
  startAllFailed: "Dual-core start transaction failed",
  startAllPartial: "Xray Core {xray} / Tachyon Core {tachyon}",
  runtimeStarted: "started",
  runtimeFailed: "failed",
  runtimeOnline: "Online",
  runtimeOffline: "Offline",
  capabilityChecking: "Checking capability",
  capabilityUnavailable: "Capability unavailable",
  stop: "Stop",
  stopAll: "Stop All",
  stopAllComplete: "Xray Core and Tachyon Core stopped",
  stopAllFailed: "Dual-core stop transaction failed",
  subscriptions: "Subscriptions",
  tachyon: "Tachyon",
  tachyonAdaptiveFec: "TGP Adaptive FEC",
  tachyonAdaptiveFecDesc: "Dynamic parity tuning",
  tachyonFecShards: "TGP FEC Shards",
  tachyonFecTiming: "TGP FEC Timing",
  tachyonConnectionMigration: "TGP Connection Migration",
  tachyonConnectionMigrationDesc: "Keep game sessions alive across IP or network changes",
  tachyonLocalAddrs: "TGP Local Bind Addresses",
  tachyonMultipath: "TGP Multipath",
  tachyonMultipathDesc: "Send game UDP over multiple interfaces",
  tachyonServer: "Tachyon Server",
  tachyonServerAddress: "Server address",
  tachyonServerName: "Server name",
  tachyonServerPort: "Port",
  tachyonServerRemark: "Remark",
  tachyonServerProfiles: "Tachyon Server Profiles",
  tachyonServerEditing: "Editing Tachyon server",
  tachyonServerRemoved: "Tachyon server removed",
  tachyonServerSaved: "Tachyon server saved",
  tachyonServerSelected: "Tachyon server selected",
  tachyonServerNoRemark: "No remark",
  tachyonServerProfileDesc: "Tachyon servers are separate from Xray subscription nodes and feed Core client.json.",
  tachyonTgpAuthPsk: "TGP Shared PSK",
  tachyonTgpAuthPskDesc: "Copy tgp.auth.psk from the Tachyon game server server.json; at least 16 characters, not from Xray subscription nodes",
  tachyonTgpServer: "TGP Server",
  tachyonTunAutoRoute: "TUN Auto Route",
  tachyonTunDnsHijack: "DNS Hijack",
  traffic: "Traffic",
  trafficNoSamplesHint: "Start Xray or Tachyon Core to draw real dual-core traffic curves here.",
  trafficSource: "Source",
  update: "Update",
  updateAll: "Update All",
  upload: "Upload",
  useManaged: "Use Managed",
  xray: "Xray",
  aboutDescription: "A cross-platform proxy GUI for Xray Core and Tachyon Core.",
  adminRestart: "Run as administrator (requires restart)",
  advancedXrayConfig: "Advanced Xray JSON",
  advancedXrayDescription: "Edit the complete config directly. Unknown fields and future protocols remain untouched. Xray config-test runs before save and start.",
  advancedXrayEnable: "Use advanced complete config",
  advancedXrayExport: "Export JSON",
  advancedXrayExportFailed: "Xray JSON export failed",
  advancedXrayImport: "Import JSON",
  advancedXrayImportFailed: "Xray JSON import failed",
  advancedXrayImported: "Complete Xray JSON imported",
  advancedXrayRestored: "Restored the last valid Xray config",
  advancedXrayRestore: "Restore Valid",
  advancedXrayRestoreGenerated: "Restore Generated",
  advancedXrayValidated: "Xray config validated and saved",
  canonicalXrayReadFailed: "Could not read the last valid Xray config; the current draft was not changed",
  configSaveFailed: "Config save failed",
  configValidationFailed: "Config validation failed",
  coreConfigGenerationFailed: "Tachyon Core config generation failed",
  coreConfigDraftUnavailable: "No Tachyon Core config draft is available",
  xrayConfigDraftUnavailable: "No Xray config draft is available",
  xrayConfigGenerationFailed: "Xray config generation failed",
  xrayJsonValidationFailed: "Xray JSON validation failed",
  xraySelectNodeRequired: "Select a subscription node before generating Xray config",
  allowPluginNodeAccess: "Allow plugins to read nodes",
  autoUpdatePlugins: "Auto-update plugins",
  behavior: "Behavior",
  checkUpdates: "Check Updates",
  color: "Color",
  copyCore: "Copy Core",
  copyXray: "Copy Xray",
  clientDiagnostics: "Client Diagnostics",
  clientDiagnosticsDesc: "Export a redacted support package: read-only, no-spawn, no-proxy, no-TUN.",
  diagnosticsNoProxy: "Does not enable system proxy",
  diagnosticsNoSpawn: "Does not start or execute Core/Xray",
  diagnosticsNoTun: "Does not enable Tachyon TUN",
  diagnosticsReadOnly: "Does not write runtime settings",
  diagnosticsReviewReminder: "Before sharing, manually review the exported JSON and confirm redaction looks right.",
  diagnosticsExported: "Diagnostics support package exported",
  exportDiagnostics: "Export diagnostics",
  validateConfigs: "Validate Configs",
  validationFailed: "Failed",
  custom: "Custom",
  dark: "Dark",
  defaultColor: "Default",
  displayName: "Display name",
  downloadRate: "Download rate",
  executablePath: "Executable path",
  expand: "Expand",
  filter: "Filter",
  fixedWindow: "Fixed 800 × 540 window",
  followSystem: "Follow system",
  gameMode: "Game Mode",
  globalModeDesc: "Use only the Global policy group",
  globalBlock: "Global Block",
  globalDirect: "Global Direct",
  green: "Green",
  grid: "Grid",
  leakFish: "Final Match",
  light: "Light",
  liveTelemetry: "Live Telemetry",
  localProxyProbe: "Local Proxy Probe",
  more: "More",
  noNodeSelected: "No node selected",
  noCompatibleAsset: "No compatible asset",
  noSubscriptionNodes: "No subscription nodes yet",
  noTachyonServerProfiles: "No Tachyon server profiles yet",
  proxyProbeFailed: "Local proxy probe failed",
  proxyProbeIdle: "Start Xray to test the current node through HTTP/SOCKS inbounds",
  proxyProbeNeedNode: "Select an Xray subscription node first",
  proxyProbeNeedRunning: "Start Xray before testing the current node",
  proxyProbeOk: "Local proxy probe passed",
  proxyProbeRunning: "Testing local HTTP/SOCKS proxies...",
  notConfigured: "Not configured",
  notInstalled: "Not installed",
  notProbed: "Not probed; diagnostics do not execute installed cores",
  pageVisibility: "Page visibility",
  personalized: "Personalization",
  policyGroups: "Policy Groups",
  pluginAllowNodeRead: "Allow plugins to read nodes",
  pluginAutoUpdate: "Auto-update plugins",
  pluginAllInstalled: "All built-in plugins installed and enabled",
  pluginCenter: "Plugin Center",
  pluginDisabled: "Disabled",
  pluginEnabled: "Enabled",
  pluginInstalled: "Installed",
  pluginLastRun: "Last run",
  pluginLastResult: "Last result",
  pluginNeverRun: "Never run",
  pluginNoMatches: "No plugins match this filter",
  pluginNoResult: "No result yet",
  pluginNotInstalled: "Not installed",
  pluginRunCompleted: "{title} run completed",
  pluginRollingDesc: "Improve Prism update experience with faster preview channels.",
  pluginRollingApplied: "Xray and Tachyon Core switched to preview channels",
  pluginRollingTitle: "Rolling Release",
  pluginRunCount: "Runs",
  pluginSettings: "Plugin Settings",
  pluginSourceBundled: "Built-in plugin bundled with Prism",
  pluginStatsDesc: "Efficient traffic statistics by domain and process.",
  pluginStatsSnapshot: "Xray ↑{xrayUp} ↓{xrayDown} / Tachyon ↑{tachyonUp} ↓{tachyonDown}",
  pluginStatsTitle: "Traffic Stats",
  pluginSwitchNeedLatency: "Refresh latency before running Smart Node Switch",
  pluginSwitchDesc: "Dynamic proxy selection with failover.",
  pluginSwitchTitle: "Smart Node Switch",
  pluginTriggerApp: "After app activation",
  pluginTriggerManual: "Manual trigger",
  pluginTriggerNode: "Node change",
  pluginTriggerUpdate: "On subscription update",
  pluginTransformDesc: "Node format converter with v2Ray-style imports.",
  pluginTransformSaved: "Saved Xray config draft for {node}",
  pluginTransformTitle: "Node Transform",
  pluginUnknown: "Unknown plugin",
  pluginUpdatesChecked: "Built-in plugins are up to date",
  processName: "Process name",
  purple: "Purple",
  quickStart: "Quick Start",
  ready: "Ready",
  recentRoutes: "Recent routes",
  releaseChannel: "Release channel",
  releaseAsset: "Asset",
  releasePreview: "Preview",
  releaseStable: "Stable",
  resolvedTag: "Resolved tag",
  refreshLatency: "Refresh Latency",
  runProxyProbe: "Test Node",
  routeByRule: "Route automatically by rules and process",
  ruleSets: "Rule sets",
  run: "Run",
  scheduledTasks: "Scheduled tasks",
  selector: "Selector",
  settingsAbout: "About",
  settingsGeneral: "General",
  source: "Source",
  sourceBinaryPath: "Source binary path",
  disable: "Disable",
  enable: "Enable",
  steamChildTracking: "Steam child process tracking",
  steamLauncherDetection: "Steam launcher detection",
  steamRoot: "Steam root",
  subscriptionDuplicates: "{count} duplicates",
  subscriptionImportResult: "{count} nodes imported",
  subscriptionName: "Subscription name",
  subscriptionPayload: "Paste subscription payload",
  subscriptionSkipped: "{count} skipped",
  subscriptionUnsupported: "unsupported: {protocols}",
  subscriptionUrl: "Subscription URL",
  xrayRetainedOnly: "Retained only, unsupported by Xray",
  xraySupported: "Xray supported",
  xrayUnsupported: "Unsupported by Xray",
  configFilesSaved: "Config files saved",
  configsValidated: "Available configs validated",
  configsValidationErrors: "Config validation finished with errors",
  labelCopied: "{label} copied",
  latencyRefreshed: "Latency refreshed",
  noConfigDraftAvailable: "No config draft available",
  noRemoteSubscriptions: "No remote subscriptions to update",
  nodeSelected: "Node selected",
  readyAddSubscription: "Ready to add subscription",
  routingModeSelected: "{mode} mode selected",
  subscriptionRemoved: "Subscription removed",
  subscriptionSelected: "Subscription selected",
  subscriptionsUpdated: "{count} subscriptions updated",
  subscriptionsUpdatedPartial: "{ok}/{total} subscriptions updated",
  systemProxy: "System Proxy",
  systemProxyEnabled: "Managed by Prism",
  systemProxyDisabled: "Disabled",
  systemProxyNeedsXray: "Available after Xray starts",
  systemProxyOtherActive: "Another system proxy is active",
  systemProxyUnsupported: "Unsupported by this platform backend",
  theme: "Theme",
  totalTraffic: "Total Traffic",
  tunMode: "TUN Mode",
  tunRuntimeUnavailable: "Runtime start/stop capability is not exposed yet",
  tunSettingUnavailable: "Runtime does not expose this setting yet; the generated config keeps it off",
  unavailableInThisBuild: "Disabled in this build to avoid disrupting active games",
  unavailable: "Unavailable",
  uploadRate: "Upload rate",
  urlTest: "URLTest",
  waitingTelemetry: "Waiting for telemetry stream...",
  liveWindow: "Live window",
  openCoreSettings: "Open Core Settings",
  xrayStatsActive: "Stats connected",
  xrayStatsDisabled: "Stats disabled",
  xrayStatsError: "Stats error",
  xrayStatsWaiting: "Waiting for Stats",
  xrayStopped: "Xray stopped",
  tachyonTelemetryActive: "Telemetry connected",
  tachyonTelemetryWaiting: "Waiting telemetry",
  tachyonStopped: "Tachyon stopped",
  tgpSessions: "TGP sessions",
  workMode: "Work Mode",
  windowControls: "Window controls",
  pinWindow: "Pin window",
  minimizeWindow: "Minimize window",
  maximizeUnavailable: "Maximize is unavailable for the fixed window",
  closeWindow: "Close window",
};

function selectedNode(snapshot: SubscriptionSnapshot): ProxyNode | undefined {
  return snapshot.nodes.find((node) => node.id === snapshot.selectedNodeId);
}

function nodeEndpoint(node: ProxyNode): string {
  return node.port > 0 ? `${node.address}:${node.port}` : node.address;
}

function nodeLatency(node: ProxyNode, latencyMap: NodeLatencyMap): number | null {
  const measured = latencyMap[node.id];
  return measured?.ok && measured.latencyMs !== null ? measured.latencyMs : null;
}

function nodeLatencySortValue(node: ProxyNode, latencyMap: NodeLatencyMap): number {
  const measured = nodeLatency(node, latencyMap);
  return measured ?? Number.MAX_SAFE_INTEGER;
}

function nodeAvailable(node: ProxyNode, latencyMap: NodeLatencyMap): boolean {
  if (xrayOutboundCompatibilityForNode(node).status !== "supported") {
    return false;
  }
  const measured = latencyMap[node.id];
  return !measured || Boolean(measured.ok && measured.latencyMs !== null);
}

function nodeLatencyLabel(node: ProxyNode, ui: typeof zh, latencyMap: NodeLatencyMap): string {
  if (xrayOutboundCompatibilityForNode(node).status !== "supported") {
    return ui.xrayUnsupported;
  }
  const measured = latencyMap[node.id];
  if (measured && !measured.ok) {
    return ui.unavailable;
  }
  const latency = nodeLatency(node, latencyMap);
  return latency === null ? "--" : `${latency}ms`;
}

function nodeXrayCompatibilityLabel(node: ProxyNode, ui: typeof zh): string {
  const compatibility = xrayOutboundCompatibilityForNode(node);
  return compatibility.status === "supported" ? ui.xraySupported : ui.xrayRetainedOnly;
}

function nodeXrayCompatibilityTitle(node: ProxyNode, ui: typeof zh): string {
  const compatibility = xrayOutboundCompatibilityForNode(node);
  return compatibility.reason ?? nodeXrayCompatibilityLabel(node, ui);
}

function processStatusLabel(status: ProcessStatus | undefined): string {
  if (!status) {
    return "unknown";
  }
  if (status.state === "failed" && status.lastError) {
    return `failed: ${status.lastError}`;
  }
  return status.pid ? `${status.state} pid ${status.pid}` : status.state;
}

function proxyProbeSummary(result: ProxyProbeResult | null | undefined): string {
  if (!result) {
    return "--";
  }
  if (result.ok) {
    const latency = result.latencyMs === null ? "n/a" : `${result.latencyMs}ms`;
    return `HTTP ${result.statusCode ?? "?"} / ${latency}`;
  }
  return result.error || "failed";
}

function proxyProbeMessage(report: LocalProxyProbeReport, ui: typeof zh): string {
  if (report.ok) {
    return `${ui.proxyProbeOk}: HTTP ${proxyProbeSummary(report.http)} / SOCKS ${proxyProbeSummary(report.socks)}`;
  }
  const failures = [
    report.http.ok ? "" : `HTTP: ${proxyProbeSummary(report.http)}`,
    report.socks.ok ? "" : `SOCKS: ${proxyProbeSummary(report.socks)}`,
  ].filter(Boolean);
  return `${ui.proxyProbeFailed}: ${failures.join(" / ")}`;
}

function systemProxyLabel(status: SystemProxyState | null): string {
  if (!status) {
    return "unknown";
  }
  if (!status.supported) {
    return "unsupported";
  }
  if (status.matchesPrism) {
    return "enabled";
  }
  return status.enabled ? "other proxy" : "disabled";
}

function privilegeLabel(status: RuntimePrivilegeStatus | null): string {
  if (!status) {
    return "unknown";
  }
  return status.canManageTun ? "TUN capable" : "needs admin/TUN capability";
}

function formatBytes(value: number | null): string {
  if (value === null) {
    return "--";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRate(value: number): string {
  if (value < 1024) {
    return `${value.toFixed(0)} B/s`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB/s`;
  }
  return `${(value / 1024 / 1024).toFixed(2)} MB/s`;
}

function displayPath(value: string, ui: typeof zh): string {
  return value.startsWith("Preview mode")
    ? `${ui.previewMode}${value.slice("Preview mode".length)}`
    : value;
}

function managedStatusLabel(binary: ManagedBinaryInfo, ui: typeof zh): string {
  return binary.managedExists
    ? `${ui.installed}, ${formatBytes(binary.managedSizeBytes)}`
    : ui.notInstalled;
}

function configuredStatusLabel(binary: ManagedBinaryInfo, ui: typeof zh): string {
  return binary.configuredExists ? ui.configuredPathExists : ui.configuredPathMissing;
}

function viewFromHash(hash: string): PrismView {
  const value = hash.replace(/^#\/?/, "");
  return prismViews.includes(value as PrismView) ? (value as PrismView) : "overview";
}

function loadRoutingMode(): XrayRoutingMode {
  try {
    const value = globalThis.localStorage?.getItem(routingModeStorageKey);
    return value === "direct" || value === "global" || value === "rule" ? value : "rule";
  } catch {
    return "rule";
  }
}

function saveRoutingMode(mode: XrayRoutingMode): void {
  globalThis.localStorage?.setItem(routingModeStorageKey, mode);
}

function loadXrayAdvancedEditor(): XrayAdvancedEditorState {
  try {
    const raw = globalThis.localStorage?.getItem(xrayAdvancedEditorStorageKey);
    if (!raw) {
      return { enabled: false, text: "" };
    }
    const value = JSON.parse(raw) as Partial<XrayAdvancedEditorState>;
    return {
      enabled: value.enabled === true,
      text: typeof value.text === "string" ? value.text : "",
    };
  } catch {
    return { enabled: false, text: "" };
  }
}

function saveXrayAdvancedEditor(value: XrayAdvancedEditorState): void {
  try {
    globalThis.localStorage?.setItem(xrayAdvancedEditorStorageKey, JSON.stringify(value));
  } catch {
    // Large valid configs remain usable in memory even when browser storage is unavailable.
  }
}

function downloadTextFile(fileName: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileSafeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function routingModeLabel(mode: XrayRoutingMode, ui: typeof zh): string {
  if (mode === "global") {
    return ui.globalMode;
  }
  if (mode === "direct") {
    return ui.directMode;
  }
  return ui.rulesMode;
}

function profileMatchLabel(profile: GameProfile): string {
  const labels = [
    ...profile.match.processNames,
    ...profile.match.paths,
    ...profile.match.pathPrefixes.map((path) => `${path}/*`),
    ...profile.match.steamAppIds.map((id) => `Steam ${id}`),
  ].filter(Boolean);
  return labels.join(", ") || "No match rule";
}

function managedBinaryDisplayName(kind: ManagedBinaryKind): string {
  return kind === "xray" ? "Xray Core" : "Tachyon Core";
}

function releaseChannelForKind(
  settings: RuntimeSettings,
  kind: ManagedBinaryKind,
): ReleaseChannel {
  return kind === "xray" ? settings.xrayReleaseChannel : settings.tachyonCoreReleaseChannel;
}

function setReleaseChannelForKind(
  settings: RuntimeSettings,
  kind: ManagedBinaryKind,
  channel: ReleaseChannel,
): RuntimeSettings {
  return kind === "xray"
    ? { ...settings, xrayReleaseChannel: channel }
    : { ...settings, tachyonCoreReleaseChannel: channel };
}

function emptyReleaseDiagnostics(
  kind: ManagedBinaryKind,
  selectedChannel: ReleaseChannel,
): CoreReleaseDiagnostics {
  return {
    assetName: null,
    assetSizeBytes: null,
    assetUrl: null,
    checksumActualSha256: null,
    checksumAssetName: null,
    checksumExpectedSha256: null,
    checksumMatch: null,
    checksumUrl: null,
    displayName: managedBinaryDisplayName(kind),
    installedExists: false,
    installedPath: "",
    installedVersion: null,
    kind,
    lastError: null,
    resolvedTag: null,
    selectedChannel,
  };
}

function runtimeWithTachyonServer(
  settings: RuntimeSettings,
  server: TachyonServerProfile | undefined,
): RuntimeSettings {
  if (!server) {
    return {
      ...settings,
      tachyonTunAutoRoute: false,
      tachyonTunDnsHijack: false,
    };
  }
  const endpoint = tachyonServerEndpoint(server);
  return {
    ...settings,
    tachyonServerAddress: endpoint,
    tachyonTgpAuthPsk: server.psk,
    tachyonTgpServerAddress: endpoint,
    tachyonTunAutoRoute: false,
    tachyonTunDnsHijack: false,
  };
}

function readinessText(state: ReadinessState): string {
  return state === "ok" ? "OK" : state === "warning" ? "Check" : "Fix";
}

function binaryReadiness(
  label: string,
  path: string,
  binary: ManagedBinaryInfo | undefined,
): ReadinessItem {
  if (!path) {
    return {
      detail: "Choose a managed binary or enter an executable path.",
      label,
      state: "error",
    };
  }
  if (!binary) {
    return { detail: path, label, state: "warning" };
  }
  if (binary.configuredPath === path && !binary.configuredExists) {
    return {
      detail: `Configured executable is missing: ${path}`,
      label,
      state: "error",
    };
  }
  return { detail: path, label, state: "ok" };
}

function sidecarReadiness(binary: ManagedBinaryInfo | undefined): ReadinessItem[] {
  if (!binary) {
    return [];
  }
  return binary.sidecarDependencies
    .filter((dependency) => dependency.required)
    .map((dependency) => ({
      detail: dependency.exists ? dependency.path : `Missing required sidecar: ${dependency.path}`,
      label: dependency.name,
      state: dependency.exists ? "ok" : "error",
    }));
}

function preflightCheckByCode(
  preflight: TachyonCorePreflightResult | null,
  codes: string[],
): TachyonCorePreflightCheck | null {
  const wanted = new Set(codes.map((code) => code.toUpperCase()));
  return (
    preflight?.checks.find((check) => wanted.has(check.code.toUpperCase())) ?? null
  );
}

function checkReadiness(
  check: TachyonCorePreflightCheck | null,
  label: string,
  fallback: ReadinessItem,
): ReadinessItem {
  if (!check) {
    return fallback;
  }
  const status = check.status.toLowerCase();
  return {
    detail: check.message || check.details || fallback.detail,
    label,
    state: ["error", "failed", "fail"].includes(status)
      ? "error"
      : ["warning", "warn", "skipped"].includes(status)
        ? "warning"
        : "ok",
  };
}

function preflightReadinessState(preflight: TachyonCorePreflightResult): ReadinessState {
  if (!preflight.supported) {
    return "warning";
  }
  if (!preflight.ok) {
    return preflight.overall.toLowerCase() === "error" ? "error" : "warning";
  }
  return ["warn", "warning"].includes(preflight.overall.toLowerCase()) ? "warning" : "ok";
}

function draftText(
  activeNode: ProxyNode | undefined,
  profiles: GameProfile[],
  launcherSettings: LauncherSettings,
  routingMode: XrayRoutingMode,
  runtimeSettings: RuntimeSettings,
  ui: typeof zh,
): { core: string; coreError: string; error: string; xray: string; xrayError: string } {
  let core = "";
  let coreError = "";
  let xray = "";
  let xrayError = "";

  try {
    core = stringifyDraft(
      buildCoreClientConfigDraft({
        gameProfiles: profiles,
        fecAdaptWindow: runtimeSettings.tachyonFecAdaptWindow,
        fecDataShards: runtimeSettings.tachyonFecDataShards,
        fecDynamic: runtimeSettings.tachyonFecDynamic,
        fecGroupTimeoutMs: runtimeSettings.tachyonFecGroupTimeoutMs,
        fecParityShards: runtimeSettings.tachyonFecParityShards,
        connectionMigration: runtimeSettings.tachyonConnectionMigration,
        grpcListen: runtimeSettings.tachyonGrpcListen,
        grpcPort: runtimeSettings.tachyonGrpcPort,
        ipcListen: runtimeSettings.tachyonIpcListen,
        ipcPort: runtimeSettings.tachyonIpcPort,
        launchers: launcherSettings,
        localAddrs: parseLocalAddrs(runtimeSettings.tachyonLocalAddrs),
        multipath: runtimeSettings.tachyonMultipath,
        serverAddr: runtimeSettings.tachyonServerAddress,
        telemetryIntervalMs: runtimeSettings.tachyonTelemetryIntervalMs,
        tgpAuthPsk: runtimeSettings.tachyonTgpAuthPsk,
        tgpServerAddr: runtimeSettings.tachyonTgpServerAddress,
        tunAddress: runtimeSettings.tachyonTunAddress,
        tunAutoRoute: false,
        tunDnsHijack: false,
        tunMtu: runtimeSettings.tachyonTunMtu,
      }),
    );
  } catch (error) {
    coreError = error instanceof Error ? error.message : ui.coreConfigGenerationFailed;
  }

  try {
    if (!activeNode) {
      throw new Error(ui.xraySelectNodeRequired);
    }
    xray = stringifyDraft(
      buildXrayClientConfigDraft(activeNode, {
        enableStats: runtimeSettings.xrayStatsEnabled,
        httpListen: runtimeSettings.xrayHttpListen,
        httpPort: runtimeSettings.xrayHttpPort,
        routingMode,
        socksListen: runtimeSettings.xraySocksListen,
        socksPort: runtimeSettings.xraySocksPort,
        statsListen: runtimeSettings.xrayStatsListen,
        statsPort: runtimeSettings.xrayStatsPort,
      }),
    );
  } catch (error) {
    xrayError = error instanceof Error ? error.message : ui.xrayConfigGenerationFailed;
  }

  return {
    core,
    coreError,
    error: [xrayError, coreError].filter(Boolean).join(" / "),
    xray,
    xrayError,
  };
}

function parseLocalAddrs(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function fetchSubscriptionReport(sourceUrl: string): Promise<SubscriptionParseReport> {
  return parseSubscriptionWithReport(await fetchSubscriptionText(sourceUrl));
}

function subscriptionImportMessage(report: SubscriptionParseReport, ui: typeof zh): string {
  const parts = [
    templateValue(ui.subscriptionImportResult, "count", String(report.nodes.length)),
  ];
  if (report.skippedEntries > 0) {
    parts.push(templateValue(ui.subscriptionSkipped, "count", String(report.skippedEntries)));
  }
  if (report.duplicateNodes > 0) {
    parts.push(templateValue(ui.subscriptionDuplicates, "count", String(report.duplicateNodes)));
  }
  const unsupported = Object.entries(report.unsupportedProtocols)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([protocol, count]) => `${protocol}×${count}`)
    .join(", ");
  if (unsupported) {
    parts.push(templateValue(ui.subscriptionUnsupported, "protocols", unsupported));
  }
  return parts.join(" / ");
}

function templateValue(template: string, key: string, value: string): string {
  return template.replace(`{${key}}`, value);
}

function templateValues(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (current, [key, value]) => current.replace(`{${key}}`, value),
    template,
  );
}

function polyline(points: number[], width: number, height: number, padding = 0, maxValue?: number): string {
  const max = Math.max(maxValue ?? Math.max(...points, 1), 1);
  const step = (width - padding) / Math.max(points.length - 1, 1);
  return points
    .map((value, index) => {
      const x = padding + index * step;
      const y = height - (value / max) * (height - 10) - 5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function App() {
  const [activeView, setActiveView] = useState<PrismView>(() =>
    viewFromHash(globalThis.location?.hash ?? ""),
  );
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [profiles, setProfiles] = useState<GameProfile[]>(defaultGameProfiles);
  const [launcherSettings, setLauncherSettings] = useState(loadLauncherSettings);
  const [suggestions, setSuggestions] = useState<GameProfile[]>([]);
  const [steamRoot, setSteamRoot] = useState("");
  const [manualProfile, setManualProfile] = useState(emptyProfile);
  const [subscription, setSubscription] = useState(loadSubscriptionSnapshot);
  const [subscriptionName, setSubscriptionName] = useState("");
  const [subscriptionUrl, setSubscriptionUrl] = useState("");
  const [subscriptionText, setSubscriptionText] = useState("");
  const [subscriptionViewMode, setSubscriptionViewMode] = useState<SubscriptionViewMode>("grid");
  const [tachyonServers, setTachyonServers] = useState<TachyonServerSnapshot>(
    loadTachyonServerSnapshot,
  );
  const [tachyonServerDraft, setTachyonServerDraft] =
    useState<TachyonServerDraft>(emptyTachyonServerDraft);
  const [policyGroupViewMode, setPolicyGroupViewMode] = useState<SubscriptionViewMode>("grid");
  const [pluginState, setPluginState] = useState<PluginStateSnapshot>(() =>
    loadPluginState(pluginCatalogIds),
  );
  const [routingMode, setRoutingMode] = useState<XrayRoutingMode>(loadRoutingMode);
  const [xrayAdvancedEditor, setXrayAdvancedEditor] =
    useState<XrayAdvancedEditorState>(loadXrayAdvancedEditor);
  const [canonicalXrayText, setCanonicalXrayText] = useState("");
  const [canonicalXrayLoadState, setCanonicalXrayLoadState] =
    useState<CanonicalXrayLoadState>("loading");
  const [showUnavailableNodes, setShowUnavailableNodes] = useState(false);
  const [sortPolicyNodesByDelay, setSortPolicyNodesByDelay] = useState(true);
  const [expandedPolicyGroupId, setExpandedPolicyGroupId] = useState("node-selector");
  const [nodeLatencies, setNodeLatencies] = useState<NodeLatencyMap>({});
  const [nodePickerOpen, setNodePickerOpen] = useState(false);
  const [controllerOpen, setControllerOpen] = useState(false);
  const [language, setLanguage] = useState<Language>(loadLanguage);
  const [configPaths, setConfigPaths] = useState<ConfigDraftPaths | null>(null);
  const [runtimePaths, setRuntimePaths] = useState<RuntimePaths | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [runtimePrivilege, setRuntimePrivilege] = useState<RuntimePrivilegeStatus | null>(null);
  const [systemProxy, setSystemProxy] = useState<SystemProxyState | null>(null);
  const [runtimeInputs, setRuntimeInputs] = useState(emptyRuntimeInputs);
  const [managedBinaries, setManagedBinaries] = useState<ManagedBinaryInventory | null>(null);
  const [binarySourceInputs, setBinarySourceInputs] = useState(emptyBinarySourceInputs);
  const [binaryReleases, setBinaryReleases] = useState<
    Partial<Record<ManagedBinaryKind, RuntimeReleaseInfo>>
  >({});
  const [releaseDiagnostics, setReleaseDiagnostics] = useState<
    Partial<Record<ManagedBinaryKind, CoreReleaseDiagnostics>>
  >({});
  const [validationResults, setValidationResults] = useState<ValidationResults>({});
  const [tachyonPreflight, setTachyonPreflight] = useState<TachyonCorePreflightResult | null>(null);
  const [binaryBusy, setBinaryBusy] = useState(false);
  const [message, setMessage] = useState("Ready");
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryState>(() => ({
    connection: "disconnected",
    hello: null,
    latestTelemetry: null,
    recentRoutes: [],
    recentErrors: [],
  }));
  const telemetryBaseUrl = useMemo(
    () => tachyonIpcBaseUrl(runtimeInputs),
    [runtimeInputs.tachyonIpcListen, runtimeInputs.tachyonIpcPort],
  );
  const telemetryClient = useMemo(
    () => new TelemetryClient(telemetryBaseUrl),
    [telemetryBaseUrl],
  );
  const [xrayTrafficStats, setXrayTrafficStats] = useState<XrayTrafficStats>(emptyXrayTrafficStats);
  const [xrayTrafficError, setXrayTrafficError] = useState<string | null>(null);
  const [xrayProbe, setXrayProbe] = useState<XrayProbeStatus>({
    error: null,
    report: null,
    state: "idle",
  });
  const [trafficSamples, setTrafficSamples] = useState<TimedTrafficSample[]>([]);
  const previousTrafficRef = useRef<{ at: number; totals: TrafficTotals } | null>(null);
  const subscriptionNameInputRef = useRef<HTMLInputElement | null>(null);
  const t = useMemo(() => createTranslator(language), [language]);
  const ui = language === "zh-CN" ? zh : en;
  const currentSubscription = useMemo(() => activeSubscription(subscription), [subscription]);
  const subscriptionNodeCount = useMemo(() => totalSubscriptionNodes(subscription), [subscription]);
  const currentTachyonServer = useMemo(
    () => activeTachyonServer(tachyonServers),
    [tachyonServers],
  );
  const activeProfiles = useMemo(
    () => profiles.filter((profile) => profile.enabled).length,
    [profiles],
  );
  const activeNode = useMemo(() => selectedNode(subscription), [subscription]);
  const effectiveRuntimeInputs = useMemo(
    () => runtimeWithTachyonServer(runtimeInputs, currentTachyonServer),
    [currentTachyonServer, runtimeInputs],
  );
  const generatedDrafts = useMemo(
    () => draftText(activeNode, profiles, launcherSettings, routingMode, effectiveRuntimeInputs, ui),
    [activeNode, effectiveRuntimeInputs, launcherSettings, language, profiles, routingMode],
  );
  const drafts = useMemo(() => {
    if (!xrayAdvancedEditor.enabled) {
      return generatedDrafts;
    }
    let xrayError = "";
    try {
      parseXrayConfigText(xrayAdvancedEditor.text, language);
    } catch (error) {
      xrayError = error instanceof Error ? error.message : ui.xrayJsonValidationFailed;
    }
    return {
      ...generatedDrafts,
      error: [xrayError, generatedDrafts.coreError].filter(Boolean).join(" / "),
      xray: xrayAdvancedEditor.text,
      xrayError,
    };
  }, [generatedDrafts, language, xrayAdvancedEditor.enabled, xrayAdvancedEditor.text]);
  const trafficTotals = useMemo(
    () => trafficTotalsFromSources(telemetry.latestTelemetry, xrayTrafficStats),
    [telemetry.latestTelemetry, xrayTrafficStats],
  );
  const trafficRates = trafficSamples[trafficSamples.length - 1] ?? emptyTrafficSample();
  const readinessItems = useMemo<ReadinessItem[]>(() => {
    const items: ReadinessItem[] = [];
    const activeNodeCompatibility = activeNode
      ? xrayOutboundCompatibilityForNode(activeNode)
      : null;
    items.push(
      xrayAdvancedEditor.enabled && drafts.xray && !drafts.xrayError
        ? {
            detail: ui.advancedXrayDescription,
            label: ui.advancedXrayConfig,
            state: "ok",
          }
        : activeNode
        ? {
            detail:
              activeNodeCompatibility?.status === "supported"
                ? `${activeNode.name} (${activeNode.protocol.toUpperCase()})`
                : `${activeNode.name} is ${activeNodeCompatibility?.status}: ${activeNodeCompatibility?.reason}`,
            label: "Xray node",
            state: activeNodeCompatibility?.status === "supported" ? "ok" : "error",
          }
        : {
            detail: "Import a subscription or select a node before starting Xray.",
            label: "Xray node",
            state: "warning",
          },
    );
    items.push(
      currentTachyonServer
        ? {
            detail: `${currentTachyonServer.name} (${tachyonServerEndpoint(currentTachyonServer)})`,
            label: "Tachyon server",
            state: "ok",
          }
        : effectiveRuntimeInputs.tachyonServerAddress.trim()
          ? {
              detail:
                effectiveRuntimeInputs.tachyonTgpServerAddress.trim() ||
                effectiveRuntimeInputs.tachyonServerAddress.trim(),
              label: "Tachyon server",
              state: "warning",
            }
        : {
            detail: "Add and select a Tachyon server profile before starting Tachyon Core.",
            label: "Tachyon server",
            state: "error",
          },
    );
    items.push(
      drafts.xray && !drafts.xrayError
        ? { detail: "Xray client JSON can be generated.", label: "Xray config", state: "ok" }
        : {
            detail: drafts.xrayError || "Xray config needs a selected node.",
            label: "Xray config",
            state: activeNode ? "error" : "warning",
          },
    );
    items.push(
      drafts.core && !drafts.coreError
        ? { detail: "Tachyon Core client JSON can be generated.", label: "Tachyon config", state: "ok" }
        : {
            detail: drafts.coreError || "Tachyon config needs a server address.",
            label: "Tachyon config",
            state: "error",
          },
    );
    const xrayPath = runtimeInputs.xrayBinaryPath.trim();
    const corePath = runtimeInputs.tachyonCoreBinaryPath.trim();
    const xrayBinary = managedBinaries?.xray;
    const coreBinary = managedBinaries?.tachyonCore;
    items.push(binaryReadiness("Xray Core binary", xrayPath, xrayBinary));
    items.push(binaryReadiness("Tachyon Core binary", corePath, coreBinary));
    if (coreBinary?.configuredPath === corePath) {
      items.push(...sidecarReadiness(coreBinary));
    }
    items.push(
      tachyonPreflight
        ? {
            detail: tachyonCorePreflightReadinessMessage(tachyonPreflight),
            label: "Tachyon Core preflight",
            state: preflightReadinessState(tachyonPreflight),
          }
        : {
            detail: "Run Validate or Start to execute tachyon-core preflight --json.",
            label: "Tachyon Core preflight",
            state: "warning",
          },
    );
    items.push(
      checkReadiness(
        preflightCheckByCode(tachyonPreflight, ["CONFIG_VALID"]),
        "Tachyon config valid",
        drafts.core && !drafts.coreError
          ? {
              detail: "Client JSON can be generated; preflight has not confirmed Core validation yet.",
              label: "Tachyon config valid",
              state: "warning",
            }
          : {
              detail: drafts.coreError || "Tachyon config needs a server address.",
              label: "Tachyon config valid",
              state: "error",
            },
      ),
    );
    items.push(
      checkReadiness(
        preflightCheckByCode(tachyonPreflight, ["CLIENT_REQUIRES_TUN", "TUN_REQUIRED"]),
        "Client requires TUN",
        {
          detail: "Tachyon Core client mode uses a TUN device for game acceleration.",
          label: "Client requires TUN",
          state: "warning",
        },
      ),
    );
    items.push(
      checkReadiness(
        preflightCheckByCode(tachyonPreflight, ["AUTO_ROUTE_DISABLED", "AUTO_ROUTE_SEMANTICS"]),
        "auto_route=false",
        {
          detail: "auto_route=false avoids taking over the OS default route, but Core client still needs TUN device capability.",
          label: "auto_route=false",
          state: "warning",
        },
      ),
    );
    items.push(
      checkReadiness(
        preflightCheckByCode(tachyonPreflight, ["WINTUN_DLL_PRESENT"]),
        "Wintun sidecar",
        {
          detail: coreBinary?.sidecarDependencies.some((dependency) => dependency.required && dependency.exists)
            ? "Required Wintun sidecar is present."
            : "Windows Tachyon Core requires wintun.dll next to the binary.",
          label: "Wintun sidecar",
          state: coreBinary?.sidecarDependencies.some((dependency) => dependency.required && dependency.exists)
            ? "ok"
            : "warning",
        },
      ),
    );
    items.push(
      checkReadiness(
        preflightCheckByCode(tachyonPreflight, ["TUN_PRIVILEGE", "TUN_DEVICE_PRESENT"]),
        "TUN device privilege",
        runtimePrivilege?.canManageTun
          ? {
              detail: runtimePrivilege.message,
              label: "TUN device privilege",
              state: "ok",
            }
          : {
              detail:
                runtimePrivilege?.message ||
                "Tachyon game acceleration needs permission to create or open a TUN device.",
              label: "TUN device privilege",
              state: "warning",
            },
      ),
    );
    items.push(
      {
        detail: "Xray local HTTP/SOCKS proxy can be usable even when Tachyon Core game acceleration is blocked.",
        label: "Xray and Tachyon independence",
        state: "ok",
      },
    );
    items.push(
      tachyonCorePreflightStartBlockReason(tachyonPreflight)
        ? {
            detail: tachyonCorePreflightStartBlockReason(tachyonPreflight) || "",
            label: "Game acceleration startable",
            state: "error",
          }
        : {
            detail: tachyonPreflight
              ? tachyonPreflight.supported
                ? "No preflight TUN/Wintun startup blocker detected for Tachyon Core."
                : "Core version lacks preflight; validate-only fallback cannot confirm TUN/Wintun readiness."
              : "Preflight has not run yet; Start will check before launching Tachyon Core.",
            label: "Game acceleration startable",
            state: tachyonPreflight?.supported ? "ok" : "warning",
          },
    );
    items.push(
      activeProfiles > 0
        ? {
            detail: `${activeProfiles} game profile${activeProfiles === 1 ? "" : "s"} enabled.`,
            label: "Game profiles",
            state: "ok",
          }
        : {
            detail: "No enabled game profile. Add a program or scan Steam.",
            label: "Game profiles",
            state: "warning",
          },
    );
    return items;
  }, [
    activeNode,
    activeProfiles,
    drafts.core,
    drafts.coreError,
    drafts.error,
    drafts.xray,
    drafts.xrayError,
    currentTachyonServer,
    effectiveRuntimeInputs.tachyonServerAddress,
    effectiveRuntimeInputs.tachyonTgpServerAddress,
    managedBinaries,
    runtimePrivilege,
    runtimeInputs.tachyonCoreBinaryPath,
    runtimeInputs.xrayBinaryPath,
    tachyonPreflight,
    xrayAdvancedEditor.enabled,
  ]);
  const readinessErrors = useMemo(
    () => readinessItems.filter((item) => item.state === "error").length,
    [readinessItems],
  );
  const runtimeRows = [
    { label: "System Proxy", value: systemProxyLabel(systemProxy) },
    { label: "TUN Privilege", value: privilegeLabel(runtimePrivilege) },
    { label: "Xray Core", value: processStatusLabel(runtimeStatus?.xray) },
    { label: "Tachyon Core", value: processStatusLabel(runtimeStatus?.tachyonCore) },
  ];
  const xrayRunning = runtimeStatus?.xray.state === "running";
  const tachyonRunning = runtimeStatus?.tachyonCore.state === "running";
  const systemProxyActive = Boolean(systemProxy?.matchesPrism);
  const systemProxyInteractive = Boolean(
    systemProxy?.supported && (systemProxy.matchesPrism || (!systemProxy.enabled && xrayRunning)),
  );
  const systemProxyReason = !systemProxy
    ? ui.capabilityChecking
    : !systemProxy.supported
      ? systemProxy.error || ui.systemProxyUnsupported
      : systemProxy.enabled && !systemProxy.matchesPrism
        ? ui.systemProxyOtherActive
        : !systemProxy.matchesPrism && !xrayRunning
          ? ui.systemProxyNeedsXray
          : systemProxy.matchesPrism
            ? ui.systemProxyEnabled
            : ui.systemProxyDisabled;
  const connectionLabel =
    connection === "connected"
      ? t("common.connected")
      : connection === "checking"
        ? t("common.checking")
        : t("common.disconnected");

  async function refreshProfiles() {
    try {
      const nextProfiles = await listGameProfiles();
      setProfiles(nextProfiles);
      setConnection("connected");
      setMessage("Profiles loaded");
    } catch (error) {
      setConnection("disconnected");
      setMessage(error instanceof Error ? error.message : "Profile store unavailable");
    }
  }

  async function addManualProfile() {
    const displayName = manualProfile.displayName.trim();
    const processName = manualProfile.processName.trim();
    const executablePath = manualProfile.executablePath.trim();
    if (!displayName || (!processName && !executablePath)) {
      setMessage("Name and one match rule are required");
      return;
    }
    const id = `manual-${displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}`;
    const profile: GameProfile = {
      id,
      displayName,
      enabled: true,
      manual: true,
      priority: 100,
      match: {
        processNames: processName ? [processName] : [],
        paths: executablePath ? [executablePath] : [],
        pathPrefixes: [],
        sha256: [],
        steamAppIds: [],
      },
      tcpPolicy: "auto",
      udpPolicy: "tgp",
    };
    try {
      await saveGameProfile(profile);
      setManualProfile(emptyProfile);
      await refreshProfiles();
      setMessage("Profile added");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Add failed");
    }
  }

  async function removeProfile(id: string) {
    try {
      const nextProfiles = await removeGameProfile(id);
      setProfiles(nextProfiles);
      setMessage("Profile removed");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Remove failed");
    }
  }

  async function scanSteam() {
    try {
      const result = await scanSteamLibrary(steamRoot);
      setSuggestions(result.profiles);
      setConnection("connected");
      setMessage(`${result.apps.length} Steam apps found`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Steam scan failed");
    }
  }

  async function addSuggestion(profile: GameProfile) {
    try {
      await saveGameProfile({ ...profile, manual: true, priority: 80 });
      setSuggestions((current) => current.filter((item) => item.id !== profile.id));
      await refreshProfiles();
      setMessage("Steam profile added");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Add failed");
    }
  }

  function updateSteamLauncherSetting<K extends keyof LauncherSettings["steam"]>(
    key: K,
    value: LauncherSettings["steam"][K],
  ) {
    const nextSettings: LauncherSettings = {
      ...launcherSettings,
      steam: { ...launcherSettings.steam, [key]: value },
    };
    saveLauncherSettings(nextSettings);
    setLauncherSettings(nextSettings);
    setMessage("Launcher settings saved");
  }

  async function updateSubscriptionFromUrl() {
    try {
      const report = await fetchSubscriptionReport(subscriptionUrl);
      const snapshot = createSubscriptionSnapshot(
        subscriptionUrl,
        report.nodes,
        subscription,
        subscriptionName,
      );
      saveSubscriptionSnapshot(snapshot);
      setSubscription(snapshot);
      setMessage(subscriptionImportMessage(report, ui));
      void refreshNodeLatencies(report.nodes);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Subscription update failed");
    }
  }

  async function updateAllSubscriptions() {
    const remoteSubscriptions = subscription.subscriptions.filter(
      (item) => item.sourceUrl && item.sourceUrl !== "manual",
    );
    if (remoteSubscriptions.length === 0) {
      setMessage(ui.noRemoteSubscriptions);
      return;
    }

    let nextSnapshot = subscription;
    const updatedNodes: ProxyNode[] = [];
    const failures: string[] = [];

    for (const item of remoteSubscriptions) {
      try {
        const report = await fetchSubscriptionReport(item.sourceUrl);
        nextSnapshot = createSubscriptionSnapshot(item.sourceUrl, report.nodes, nextSnapshot, item.name);
        updatedNodes.push(...report.nodes);
      } catch (error) {
        failures.push(`${item.name}: ${error instanceof Error ? error.message : "update failed"}`);
      }
    }

    if (updatedNodes.length === 0) {
      setMessage(failures[0] ?? "Subscription update failed");
      return;
    }

    try {
      if (nextSnapshot.subscriptions.some((item) => item.id === subscription.selectedSubscriptionId)) {
        nextSnapshot = selectSubscription(nextSnapshot, subscription.selectedSubscriptionId);
        if (nextSnapshot.nodes.some((node) => node.id === subscription.selectedNodeId)) {
          nextSnapshot = selectSubscriptionNode(nextSnapshot, subscription.selectedNodeId);
        }
      }
    } catch {
      // Keep the freshly updated snapshot if the previous selection disappeared.
    }

    saveSubscriptionSnapshot(nextSnapshot);
    setSubscription(nextSnapshot);
    setMessage(
      failures.length > 0
        ? templateValue(
            templateValue(
              ui.subscriptionsUpdatedPartial,
              "ok",
              String(remoteSubscriptions.length - failures.length),
            ),
            "total",
            String(remoteSubscriptions.length),
          )
        : templateValue(ui.subscriptionsUpdated, "count", String(remoteSubscriptions.length)),
    );
    void refreshNodeLatencies(updatedNodes, false);
  }

  async function refreshNodeLatencies(nodes = subscription.nodes, announce = true): Promise<NodeLatencyMap> {
    if (nodes.length === 0) {
      setNodeLatencies({});
      return {};
    }
    const results: Array<readonly [string, TcpLatencyResult]> = [];
    const queue = [...nodes];
    const workerCount = Math.min(queue.length, 6);
    const measure = async (node: ProxyNode): Promise<readonly [string, TcpLatencyResult]> => {
      try {
        const result = await testTcpLatency(node.address, node.port, 2500);
        return [node.id, result] as const;
      } catch (error) {
        return [
          node.id,
          {
            error: error instanceof Error ? error.message : "latency test failed",
            latencyMs: null,
            ok: false,
          },
        ] as const;
      }
    };
    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const node = queue.shift();
        if (!node) {
          continue;
        }
        results.push(await measure(node));
      }
    });
    await Promise.all(workers);
    const nextLatencies = { ...nodeLatencies, ...Object.fromEntries(results) };
    setNodeLatencies(nextLatencies);
    if (announce) {
      setMessage(ui.latencyRefreshed);
    }
    return nextLatencies;
  }

  function importSubscriptionText() {
    try {
      const report = parseSubscriptionWithReport(subscriptionText);
      const snapshot = createSubscriptionSnapshot(
        "manual",
        report.nodes,
        subscription,
        subscriptionName || "Manual",
      );
      saveSubscriptionSnapshot(snapshot);
      setSubscription(snapshot);
      setSubscriptionText("");
      setMessage(subscriptionImportMessage(report, ui));
      void refreshNodeLatencies(report.nodes);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Subscription import failed");
    }
  }

  function chooseSubscription(subscriptionId: string) {
    try {
      const snapshot = selectSubscription(subscription, subscriptionId);
      saveSubscriptionSnapshot(snapshot);
      setSubscription(snapshot);
      setMessage(ui.subscriptionSelected);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Subscription selection failed");
    }
  }

  function chooseNode(nodeId: string) {
    try {
      const snapshot = selectSubscriptionNode(subscription, nodeId);
      saveSubscriptionSnapshot(snapshot);
      setSubscription(snapshot);
      setNodePickerOpen(false);
      setXrayProbe({ error: null, report: null, state: "idle" });
      setMessage(ui.nodeSelected);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Node selection failed");
    }
  }

  function deleteSubscription(subscriptionId: string) {
    try {
      const snapshot = removeSubscription(subscription, subscriptionId);
      saveSubscriptionSnapshot(snapshot);
      setSubscription(snapshot);
      setMessage(ui.subscriptionRemoved);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Subscription removal failed");
    }
  }

  function saveTachyonServerProfile() {
    try {
      const snapshot = upsertTachyonServerProfile(tachyonServers, tachyonServerDraft);
      const server = activeTachyonServer(snapshot);
      saveTachyonServerSnapshot(snapshot);
      setTachyonServers(snapshot);
      setTachyonServerDraft(draftFromTachyonServerProfile(server));
      setRuntimeInputs((current) => runtimeWithTachyonServer(current, server));
      setMessage(ui.tachyonServerSaved);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Tachyon server save failed");
    }
  }

  function chooseTachyonServerProfile(profileId: string) {
    try {
      const snapshot = selectTachyonServerProfile(tachyonServers, profileId);
      const server = activeTachyonServer(snapshot);
      saveTachyonServerSnapshot(snapshot);
      setTachyonServers(snapshot);
      setTachyonServerDraft(draftFromTachyonServerProfile(server));
      setRuntimeInputs((current) => runtimeWithTachyonServer(current, server));
      setMessage(ui.tachyonServerSelected);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Tachyon server selection failed");
    }
  }

  function editTachyonServerProfile(profile: TachyonServerProfile) {
    setTachyonServerDraft(draftFromTachyonServerProfile(profile));
    setMessage(ui.tachyonServerEditing);
  }

  function deleteTachyonServerProfile(profileId: string) {
    try {
      const snapshot = removeTachyonServerProfile(tachyonServers, profileId);
      const server = activeTachyonServer(snapshot);
      saveTachyonServerSnapshot(snapshot);
      setTachyonServers(snapshot);
      setTachyonServerDraft(draftFromTachyonServerProfile(server));
      setRuntimeInputs((current) => runtimeWithTachyonServer(current, server));
      setMessage(ui.tachyonServerRemoved);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Tachyon server removal failed");
    }
  }

  function changeRoutingMode(mode: XrayRoutingMode) {
    setRoutingMode(mode);
    saveRoutingMode(mode);
    setMessage(templateValue(ui.routingModeSelected, "mode", routingModeLabel(mode, ui)));
  }

  function setAdvancedXrayEnabled(enabled: boolean) {
    setXrayAdvancedEditor((current) => ({
      ...current,
      enabled,
      text: initializeAdvancedXrayDraftText({
        canonicalText: canonicalXrayText,
        enabled,
        generatedText: generatedDrafts.xray,
        loadState: canonicalXrayLoadState,
        persistedText: current.text,
      }),
    }));
  }

  function updateAdvancedXrayText(text: string) {
    setXrayAdvancedEditor((current) => ({ ...current, enabled: true, text }));
  }

  async function importAdvancedXray(file: File | undefined) {
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      parseXrayConfigText(text, language);
      setXrayAdvancedEditor((current) => ({ ...current, enabled: true, text }));
      setMessage(ui.advancedXrayImported);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : ui.advancedXrayImportFailed);
    }
  }

  function exportAdvancedXray() {
    try {
      parseXrayConfigText(drafts.xray, language);
      downloadTextFile("xray-client.json", drafts.xray, "application/json;charset=utf-8");
      setMessage(ui.advancedXrayExport);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : ui.advancedXrayExportFailed);
    }
  }

  function restoreAdvancedXray(useGenerated: boolean) {
    const text = useGenerated ? generatedDrafts.xray : canonicalXrayText;
    if (!text) {
      return;
    }
    setXrayAdvancedEditor((current) => ({ ...current, enabled: true, text }));
    setMessage(useGenerated ? ui.advancedXrayRestoreGenerated : ui.advancedXrayRestored);
  }

  function persistPluginState(nextState: PluginStateSnapshot, messageText: string) {
    savePluginState(nextState);
    setPluginState(nextState);
    setMessage(messageText);
  }

  function installPlugin(pluginId: string, pluginTitle: string) {
    persistPluginState(installPluginState(pluginState, pluginId), `${pluginTitle} installed`);
  }

  function togglePlugin(pluginId: string, pluginTitle: string) {
    const nextState = togglePluginEnabled(pluginState, pluginId);
    const nextPlugin = nextState[pluginId];
    persistPluginState(
      nextState,
      nextPlugin?.enabled ? `${pluginTitle} enabled` : `${pluginTitle} disabled`,
    );
  }

  function installAllPlugins() {
    const nextState = pluginCatalogIds.reduce<PluginStateSnapshot>(
      (current, pluginId) => installPluginState(current, pluginId),
      pluginState,
    );
    persistPluginState(nextState, ui.pluginAllInstalled);
  }

  function checkPluginUpdates() {
    setMessage(ui.pluginUpdatesChecked);
  }

  function showPluginSource(pluginTitle: string) {
    setMessage(`${pluginTitle}: ${ui.pluginSourceBundled}`);
  }

  async function runPlugin(pluginId: string, pluginTitle: string) {
    try {
      if (pluginId === "rolling-release") {
        const settings = await saveRuntimeSettings({
          ...runtimeInputs,
          tachyonCoreReleaseChannel: "preview",
          xrayReleaseChannel: "preview",
        });
        setRuntimeInputs(settings);
        const result = ui.pluginRollingApplied;
        persistPluginState(recordPluginRun(pluginState, pluginId, { result }), result);
        return;
      }

      if (pluginId === "node-transform") {
        if (!activeNode) {
          throw new Error(ui.noNodeSelected);
        }
        await writeDrafts("xray");
        const result = templateValue(ui.pluginTransformSaved, "node", activeNode.name);
        persistPluginState(recordPluginRun(pluginState, pluginId, { result }), result);
        return;
      }

      if (pluginId === "traffic-stats") {
        const stats = await getXrayTrafficStats();
        setXrayTrafficStats(stats);
        const totals = trafficTotalsFromSources(telemetry.latestTelemetry, stats);
        const result = templateValues(ui.pluginStatsSnapshot, {
          tachyonDown: formatBytes(totals.tachyonDown),
          tachyonUp: formatBytes(totals.tachyonUp),
          xrayDown: formatBytes(totals.xrayDown),
          xrayUp: formatBytes(totals.xrayUp),
        });
        persistPluginState(recordPluginRun(pluginState, pluginId, { result }), result);
        return;
      }

      if (pluginId === "smart-node-switch") {
        let latencyMap = nodeLatencies;
        const hasMeasuredNodes = subscription.nodes.some(
          (node) => nodeAvailable(node, latencyMap) && nodeLatency(node, latencyMap) !== null,
        );
        if (!hasMeasuredNodes) {
          latencyMap = await refreshNodeLatencies(subscription.nodes, false);
        }
        const bestNode = [...subscription.nodes]
          .filter((node) => nodeAvailable(node, latencyMap) && nodeLatency(node, latencyMap) !== null)
          .sort(
            (left, right) =>
              nodeLatencySortValue(left, latencyMap) - nodeLatencySortValue(right, latencyMap),
          )[0];
        if (!bestNode) {
          throw new Error(ui.pluginSwitchNeedLatency);
        }
        const snapshot = selectSubscriptionNode(subscription, bestNode.id);
        saveSubscriptionSnapshot(snapshot);
        setSubscription(snapshot);
        const result = `${pluginTitle} -> ${bestNode.name}`;
        const nextPluginState = recordPluginRun(pluginState, pluginId, { result });
        savePluginState(nextPluginState);
        setPluginState(nextPluginState);
        setMessage(result);
        return;
      }

      const result = templateValue(ui.pluginRunCompleted, "title", pluginTitle);
      persistPluginState(recordPluginRun(pluginState, pluginId, { result }), result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Plugin run failed");
    }
  }

  function prepareSubscriptionAdd() {
    navigateView("subscriptions");
    setSubscriptionName("");
    setSubscriptionUrl("");
    setSubscriptionText("");
    setMessage(ui.readyAddSubscription);
    globalThis.setTimeout?.(() => subscriptionNameInputRef.current?.focus(), 50);
  }

  async function copyDraft(label: string, value: string) {
    if (!value) {
      setMessage(ui.noConfigDraftAvailable);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setMessage(templateValue(ui.labelCopied, "label", label));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Copy failed");
    }
  }

  async function exportDiagnostics() {
    try {
      const generatedAt = new Date().toISOString();
      const supportPackage = buildClientDiagnosticsExport({
        generatedAt,
        managedBinaries,
        platform: globalThis.navigator?.platform ?? "unknown",
        recentErrors: [
          xrayProbe.error,
          xrayTrafficError,
          runtimeStatus?.xray.lastError,
          runtimeStatus?.tachyonCore.lastError,
          releaseDiagnostics.xray?.lastError,
          releaseDiagnostics.tachyonCore?.lastError,
          ...telemetry.recentErrors.map((error) =>
            error.source ? `${error.source}: ${error.message}` : error.message,
          ),
        ].filter((value): value is string => Boolean(value)),
        releaseDiagnostics,
        runtimeSettings: runtimeInputs,
        runtimeStatus,
        selectedNode: activeNode,
        subscription,
        userAgent: globalThis.navigator?.userAgent ?? "",
        version: prismVersion,
        xrayLocalProxyProbe: xrayProbe.report,
      });
      downloadTextFile(
        `tachyon-prism-diagnostics-${fileSafeTimestamp(generatedAt)}.json`,
        stringifyDiagnosticsExport(supportPackage),
        "application/json;charset=utf-8",
      );
      setMessage(ui.diagnosticsExported);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Diagnostics export failed");
    }
  }

  async function commitXrayDraft(): Promise<ConfigDraftPaths> {
    if (!drafts.xray) {
      throw new Error(drafts.xrayError || ui.xrayConfigDraftUnavailable);
    }
    parseXrayConfigText(drafts.xray, language);
    const paths = await commitValidatedXrayConfig(drafts.xray);
    setCanonicalXrayText(drafts.xray);
    setConfigPaths(paths);
    setValidationResults((current) => ({
      ...current,
      xray: {
        command: "commit_validated_xray_config",
        details: ui.advancedXrayValidated,
        error: null,
        ok: true,
        target: paths.xrayConfigPath,
      },
    }));
    return paths;
  }

  async function writeDrafts(kind: ManagedBinaryKind | "all" = "all"): Promise<ConfigDraftPaths> {
    if (kind === "xray") {
      return commitXrayDraft();
    }

    if (kind === "tachyonCore") {
      if (!drafts.core) {
        throw new Error(drafts.coreError || ui.coreConfigDraftUnavailable);
      }
      const paths = await saveConfigDraft("core", drafts.core);
      setConfigPaths(paths);
      return paths;
    }

    if (!drafts.core && !drafts.xray) {
      throw new Error(drafts.error || ui.noConfigDraftAvailable);
    }
    if (!drafts.core) {
      return commitXrayDraft();
    }
    if (!drafts.xray) {
      const paths = await saveConfigDraft("core", drafts.core);
      setConfigPaths(paths);
      return paths;
    }
    await saveConfigDraft("core", drafts.core);
    return commitXrayDraft();
  }

  async function saveDrafts() {
    try {
      const settings = await saveRuntimeSettings(effectiveRuntimeInputs);
      setRuntimeInputs(settings);
      await writeDrafts("all");
      setMessage(drafts.xray ? ui.advancedXrayValidated : ui.configFilesSaved);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : ui.configSaveFailed);
    }
  }

  async function runTachyonConfigValidation(
    paths: ConfigDraftPaths,
    settings: RuntimeSettings,
    announce = true,
  ): Promise<ConfigValidationResult> {
    const result = await validateTachyonCoreConfig(
      settings.tachyonCoreBinaryPath,
      paths.coreConfigPath,
    );
    setValidationResults((current) => ({ ...current, tachyonCore: result }));
    if (!result.ok) {
      throw new Error(
        result.error || `${managedBinaryDisplayName("tachyonCore")}: ${ui.configValidationFailed}`,
      );
    }
    if (announce) {
      const preflight = await runTachyonCorePreflight(paths, settings);
      setMessage(tachyonCorePreflightReadinessMessage(preflight));
    }
    return result;
  }

  async function runTachyonCorePreflight(
    paths: ConfigDraftPaths,
    settings: RuntimeSettings,
  ): Promise<TachyonCorePreflightResult> {
    const result = await preflightTachyonCore(settings.tachyonCoreBinaryPath, paths.coreConfigPath);
    setTachyonPreflight(result);
    return result;
  }

  async function assertTachyonCoreStartable(
    paths: ConfigDraftPaths,
    settings: RuntimeSettings,
  ): Promise<TachyonCorePreflightResult> {
    const result = await runTachyonCorePreflight(paths, settings);
    const blocker = tachyonCorePreflightStartBlockReason(result);
    if (blocker) {
      throw new Error(blocker);
    }
    return result;
  }

  async function validateAllConfigs() {
    try {
      const settings = await saveRuntimeSettings(effectiveRuntimeInputs);
      setRuntimeInputs(settings);
      const paths = await writeDrafts("all");
      const results: ConfigValidationResult[] = [];
      let preflightFallback: string | null = null;
      if (drafts.core) {
        results.push(await runTachyonConfigValidation(paths, settings, false));
        const preflight = await runTachyonCorePreflight(paths, settings);
        preflightFallback = tachyonCorePreflightReadinessMessage(preflight);
      }
      const ok = Boolean(drafts.xray || results.length > 0) && results.every((result) => result.ok);
      setMessage(preflightFallback || (ok ? ui.configsValidated : ui.configsValidationErrors));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : ui.configValidationFailed);
    }
  }

  async function saveRuntimeInputs() {
    try {
      const settings = await saveRuntimeSettings(effectiveRuntimeInputs);
      setRuntimeInputs(settings);
      setMessage("Runtime paths saved");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Runtime settings save failed");
    }
  }

  async function refreshManagedBinaries() {
    try {
      const inventory = await getManagedBinaries();
      setManagedBinaries(inventory);
      setRuntimeInputs(inventory.runtimeSettings);
    } catch {
      // Managed binary commands are available only inside Tauri.
    }
  }

  function binaryInfo(kind: ManagedBinaryKind): ManagedBinaryInfo | null {
    if (!managedBinaries) {
      return null;
    }
    return kind === "xray" ? managedBinaries.xray : managedBinaries.tachyonCore;
  }

  async function installBinary(kind: ManagedBinaryKind) {
    const sourcePath = binarySourceInputs[kind].trim();
    if (!sourcePath) {
      setMessage("Source binary path required");
      return;
    }
    try {
      const inventory = await installManagedBinary(kind, sourcePath);
      setManagedBinaries(inventory);
      setRuntimeInputs(inventory.runtimeSettings);
      const installed = kind === "xray" ? inventory.xray : inventory.tachyonCore;
      setMessage(`${installed.displayName} installed`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Binary install failed");
    }
  }

  async function useManagedBinary(kind: ManagedBinaryKind) {
    const binary = binaryInfo(kind);
    if (!binary) {
      setMessage("Binary inventory unavailable");
      return;
    }
    if (!binary.managedExists) {
      setMessage(`${binary.displayName} is not installed`);
      return;
    }
    try {
      const nextSettings =
        kind === "xray"
          ? { ...runtimeInputs, xrayBinaryPath: binary.targetPath }
          : { ...runtimeInputs, tachyonCoreBinaryPath: binary.targetPath };
      const settings = await saveRuntimeSettings(nextSettings);
      setRuntimeInputs(settings);
      await refreshManagedBinaries();
      setMessage(`${binary.displayName} selected`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Binary selection failed");
    }
  }

  async function checkLatestRelease(kind: ManagedBinaryKind) {
    try {
      setBinaryBusy(true);
      const settings = await saveRuntimeSettings(effectiveRuntimeInputs);
      setRuntimeInputs(settings);
      const release =
        kind === "xray" ? await getLatestXrayRelease() : await getLatestTachyonCoreRelease();
      setBinaryReleases((current) => ({ ...current, [kind]: release }));
      setReleaseDiagnostics((current) => ({
        ...current,
        [kind]: {
          ...(current[kind] ?? emptyReleaseDiagnostics(kind, releaseChannelForKind(settings, kind))),
          assetName: release.assetName,
          assetSizeBytes: release.assetSizeBytes,
          assetUrl: release.assetUrl,
          checksumAssetName: release.checksumAssetName,
          checksumUrl: release.checksumUrl,
          lastError: null,
          resolvedTag: release.tagName,
          selectedChannel: releaseChannelForKind(settings, kind),
        },
      }));
      setMessage(`${releaseChannelForKind(settings, kind)} ${managedBinaryDisplayName(kind)} ${release.tagName}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `${managedBinaryDisplayName(kind)} release check failed`;
      setReleaseDiagnostics((current) => ({
        ...current,
        [kind]: {
          ...emptyReleaseDiagnostics(kind, releaseChannelForKind(effectiveRuntimeInputs, kind)),
          lastError: message,
        },
      }));
      setMessage(message);
    } finally {
      setBinaryBusy(false);
    }
  }

  async function diagnoseCoreRelease(kind: ManagedBinaryKind) {
    try {
      setBinaryBusy(true);
      const diagnostics = await getCoreReleaseDiagnostics(kind);
      setReleaseDiagnostics((current) => ({ ...current, [kind]: diagnostics }));
      if (diagnostics.resolvedTag && diagnostics.assetName) {
        setBinaryReleases((current) => ({
          ...current,
          [kind]: {
            assetName: diagnostics.assetName ?? "",
            assetSizeBytes: diagnostics.assetSizeBytes ?? 0,
            assetUrl: diagnostics.assetUrl ?? "",
            checksumAssetName: diagnostics.checksumAssetName ?? "",
            checksumUrl: diagnostics.checksumUrl ?? "",
            publishedAt: null,
            tagName: diagnostics.resolvedTag ?? "",
          },
        }));
      }
      setMessage(
        diagnostics.lastError
          ? `${managedBinaryDisplayName(kind)} diagnostics: ${diagnostics.lastError}`
          : `${managedBinaryDisplayName(kind)} diagnostics ready for saved settings`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `${managedBinaryDisplayName(kind)} diagnostics failed`;
      setReleaseDiagnostics((current) => ({
        ...current,
        [kind]: {
          ...emptyReleaseDiagnostics(kind, releaseChannelForKind(effectiveRuntimeInputs, kind)),
          lastError: message,
        },
      }));
      setMessage(message);
    } finally {
      setBinaryBusy(false);
    }
  }

  async function downloadLatestRelease(kind: ManagedBinaryKind) {
    try {
      setBinaryBusy(true);
      const settings = await saveRuntimeSettings(effectiveRuntimeInputs);
      setRuntimeInputs(settings);
      const result =
        kind === "xray" ? await installLatestXray() : await installLatestTachyonCore();
      setBinaryReleases((current) => ({ ...current, [kind]: result.release }));
      setManagedBinaries(result.inventory);
      setRuntimeInputs(result.inventory.runtimeSettings);
      setReleaseDiagnostics((current) => ({
        ...current,
        [kind]: {
          ...emptyReleaseDiagnostics(kind, releaseChannelForKind(result.inventory.runtimeSettings, kind)),
          assetName: result.release.assetName,
          assetSizeBytes: result.release.assetSizeBytes,
          assetUrl: result.release.assetUrl,
          checksumActualSha256: result.sha256,
          checksumAssetName: result.release.checksumAssetName,
          checksumExpectedSha256: result.sha256,
          checksumMatch: true,
          checksumUrl: result.release.checksumUrl,
          installedExists: true,
          installedPath: result.binaryPath,
          lastError: null,
          resolvedTag: result.release.tagName,
        },
      }));
      setMessage(`${managedBinaryDisplayName(kind)} ${result.release.tagName} installed`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${managedBinaryDisplayName(kind)} install failed`);
    } finally {
      setBinaryBusy(false);
    }
  }

  async function installWintun() {
    try {
      setBinaryBusy(true);
      const settings = await saveRuntimeSettings(effectiveRuntimeInputs);
      setRuntimeInputs(settings);
      const inventory = await installWintunSidecar();
      setManagedBinaries(inventory);
      setRuntimeInputs(inventory.runtimeSettings);
      setMessage("wintun.dll installed");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Wintun install failed");
    } finally {
      setBinaryBusy(false);
    }
  }

  async function refreshRuntime() {
    try {
      const status = await getRuntimeStatus();
      setRuntimeStatus(status);
    } catch {
      // Runtime supervision commands are available only inside Tauri.
    }
  }

  async function refreshRuntimePrivilege() {
    try {
      const status = await getRuntimePrivilegeStatus();
      setRuntimePrivilege(status);
      return status;
    } catch {
      // Privilege probing is desktop-only and platform-dependent.
      return null;
    }
  }

  async function refreshSystemProxy() {
    try {
      const status = await getSystemProxyStatus();
      setSystemProxy(status);
    } catch {
      // System proxy commands are desktop-only and platform-dependent.
    }
  }

  async function toggleSystemProxy() {
    if (!systemProxyInteractive) {
      setMessage(systemProxyReason);
      return;
    }
    try {
      const status = systemProxyActive
        ? await disableSystemProxy()
        : await enableSystemProxy();
      setSystemProxy(status);
      setMessage(status.matchesPrism ? ui.systemProxyEnabled : ui.systemProxyDisabled);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : ui.capabilityUnavailable);
      await refreshSystemProxy();
    }
  }

  async function probeXrayProxy() {
    try {
      if (!activeNode) {
        setXrayProbe({ error: ui.proxyProbeNeedNode, report: null, state: "error" });
        setMessage(ui.proxyProbeNeedNode);
        return;
      }
      const settings = await saveRuntimeSettings(effectiveRuntimeInputs);
      setRuntimeInputs(settings);
      const status = await getRuntimeStatus();
      setRuntimeStatus(status);
      if (status.xray.state !== "running") {
        const error = status.xray.lastError
          ? `${ui.proxyProbeNeedRunning}: ${status.xray.lastError}`
          : ui.proxyProbeNeedRunning;
        setXrayProbe({ error, report: null, state: "error" });
        setMessage(error);
        return;
      }
      setXrayProbe((current) => ({ ...current, error: null, state: "running" }));
      setMessage(ui.proxyProbeRunning);
      const report = await testXrayLocalProxies();
      setXrayProbe({
        error: report.ok ? null : proxyProbeMessage(report, ui),
        report,
        state: report.ok ? "ok" : "error",
      });
      setMessage(proxyProbeMessage(report, ui));
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.proxyProbeFailed;
      setXrayProbe({ error: message, report: null, state: "error" });
      setMessage(message);
    }
  }

  async function startRuntime(kind: ManagedBinaryKind): Promise<RuntimeStartResult> {
    try {
      const settings = await saveRuntimeSettings(effectiveRuntimeInputs);
      setRuntimeInputs(settings);
      const paths = await writeDrafts(kind);
      if (kind === "tachyonCore") {
        await runTachyonConfigValidation(paths, settings, false);
        const preflight = await assertTachyonCoreStartable(paths, settings);
        setMessage(tachyonCorePreflightReadinessMessage(preflight));
      }
      const status =
        kind === "xray"
          ? await startXray(settings.xrayBinaryPath, paths.xrayConfigPath)
          : await startTachyonCore(settings.tachyonCoreBinaryPath, paths.coreConfigPath);
      setRuntimeStatus((current) => ({
        tachyonCore:
          kind === "tachyonCore"
            ? status
            : current?.tachyonCore ?? {
                binaryPath: null,
                configPath: null,
                lastError: null,
                pid: null,
                startedAt: null,
                state: "stopped",
              },
        xray:
          kind === "xray"
            ? status
            : current?.xray ?? {
                binaryPath: null,
                configPath: null,
                lastError: null,
                pid: null,
                startedAt: null,
                state: "stopped",
              },
      }));
      setMessage(`${managedBinaryDisplayName(kind)} started`);
      return { error: null, ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.runtimeFailed;
      setMessage(message);
      return { error: message, ok: false };
    }
  }

  async function stopRuntime(kind: ManagedBinaryKind) {
    try {
      const status = kind === "xray" ? await stopXray() : await stopTachyonCore();
      setRuntimeStatus((current) => ({
        tachyonCore:
          kind === "tachyonCore"
            ? status
            : current?.tachyonCore ?? {
                binaryPath: null,
                configPath: null,
                lastError: null,
                pid: null,
                startedAt: null,
                state: "stopped",
              },
        xray:
          kind === "xray"
            ? status
            : current?.xray ?? {
                binaryPath: null,
                configPath: null,
                lastError: null,
                pid: null,
                startedAt: null,
                state: "stopped",
              },
      }));
      setMessage(`${managedBinaryDisplayName(kind)} stopped`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Stop failed");
    }
  }

  async function toggleRuntime(kind: ManagedBinaryKind) {
    const currentStatus = kind === "xray" ? runtimeStatus?.xray : runtimeStatus?.tachyonCore;
    if (currentStatus?.state === "running") {
      await stopRuntime(kind);
      return;
    }
    await startRuntime(kind);
  }

  async function startAllRuntime() {
    try {
      const settings = await saveRuntimeSettings(effectiveRuntimeInputs);
      setRuntimeInputs(settings);
      const paths = await writeDrafts("all");
      await runTachyonConfigValidation(paths, settings, false);
      const preflight = await assertTachyonCoreStartable(paths, settings);
      setMessage(tachyonCorePreflightReadinessMessage(preflight));
      const result = await invokeDesktop<StartAllResult>("start_all", {
        tachyonCoreBinaryPath: settings.tachyonCoreBinaryPath,
        tachyonCoreConfigPath: paths.coreConfigPath,
        xrayBinaryPath: settings.xrayBinaryPath,
        xrayConfigPath: paths.xrayConfigPath,
      });
      setRuntimeStatus(result.runtime);
      setMessage(ui.startAllComplete);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error || ui.capabilityUnavailable);
      setMessage(`${ui.startAllFailed}: ${detail}`);
      await refreshRuntime();
    }
  }

  async function stopAllRuntime() {
    try {
      const result = await invokeDesktop<StopAllResult>("stop_all");
      setRuntimeStatus(result.runtime);
      setMessage(
        result.errors.length === 0
          ? ui.stopAllComplete
          : `${ui.stopAllFailed}: ${result.errors.join("; ")}`,
      );
      if (result.errors.length > 0) {
        await refreshRuntime();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error || ui.capabilityUnavailable);
      setMessage(`${ui.stopAllFailed}: ${detail}`);
      await refreshRuntime();
    } finally {
      await refreshSystemProxy();
    }
  }

  async function handleWindowAction(action: "pin" | "minimize" | "close") {
    if (!isTauriRuntime()) {
      return;
    }
    try {
      if (action === "pin") {
        const enabled = await invokeDesktop<boolean>("window_set_always_on_top", {
          value: !alwaysOnTop,
        });
        setAlwaysOnTop(enabled);
        return;
      }
      if (action === "minimize") {
        await invokeDesktop<void>("window_minimize");
        return;
      }
      await invokeDesktop<void>("window_close");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Window action failed");
    }
  }

  function titlebarDragBlocked(target: EventTarget | null): boolean {
    return target instanceof HTMLElement
      ? Boolean(target.closest("button, input, select, textarea, a, [data-no-window-drag]"))
      : false;
  }

  function startWindowDrag(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0 || titlebarDragBlocked(event.target)) {
      return;
    }
    event.preventDefault();
    void getCurrentWindow()
      .startDragging()
      .catch(() => invokeDesktop<void>("window_start_dragging"))
      .catch(() => undefined);
  }

  function changeLanguage(nextLanguage: Language) {
    saveLanguage(nextLanguage);
    setLanguage(nextLanguage);
    setMessage(nextLanguage === "zh-CN" ? "语言已更新" : "Language updated");
  }

  function navigateView(view: PrismView) {
    setActiveView(view);
    const nextHash = `#${view}`;
    if (globalThis.location?.hash !== nextHash) {
      globalThis.history?.replaceState(null, "", nextHash);
    }
  }

  useEffect(() => {
    saveXrayAdvancedEditor(xrayAdvancedEditor);
  }, [xrayAdvancedEditor]);

  useEffect(() => {
    let active = true;
    void readCanonicalXrayConfig()
      .then((canonical) => {
        if (!active) {
          return;
        }
        if (canonical.exists && canonical.contents !== null) {
          setCanonicalXrayText(canonical.contents);
        }
        setCanonicalXrayLoadState("loaded");
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setCanonicalXrayLoadState("error");
        setMessage(ui.canonicalXrayReadFailed);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setXrayAdvancedEditor((current) => {
      const text = initializeAdvancedXrayDraftText({
        canonicalText: canonicalXrayText,
        enabled: current.enabled,
        generatedText: generatedDrafts.xray,
        loadState: canonicalXrayLoadState,
        persistedText: current.text,
      });
      return text === current.text ? current : { ...current, text };
    });
  }, [
    canonicalXrayLoadState,
    canonicalXrayText,
    generatedDrafts.xray,
  ]);

  useEffect(() => {
    const onHashChange = () => setActiveView(viewFromHash(globalThis.location?.hash ?? ""));
    globalThis.addEventListener?.("hashchange", onHashChange);
    return () => globalThis.removeEventListener?.("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    void refreshProfiles();
    void getConfigPaths()
      .then((paths) => setConfigPaths(paths))
      .catch(() => undefined);
    void getRuntimePaths()
      .then((paths) => {
        setRuntimePaths(paths);
        setRuntimeInputs({
          ...emptyRuntimeInputs,
          tachyonCoreBinaryPath: paths.tachyonCoreBinaryPath,
          tachyonCoreReleaseChannel: "preview",
          xrayBinaryPath: paths.xrayBinaryPath,
          xrayReleaseChannel: "stable",
        });
      })
      .catch(() => undefined);
    void getRuntimeSettings()
      .then((settings) => setRuntimeInputs(settings))
      .catch(() => undefined);
    void refreshManagedBinaries();
    void refreshRuntime();
    void refreshRuntimePrivilege();
    void refreshSystemProxy();
  }, []);

  useEffect(() => {
    setSubscriptionName(currentSubscription?.name ?? "");
    setSubscriptionUrl(
      currentSubscription && currentSubscription.sourceUrl !== "manual"
        ? currentSubscription.sourceUrl
        : "",
    );
  }, [currentSubscription]);

  useEffect(() => {
    if (currentTachyonServer) {
      setTachyonServerDraft(draftFromTachyonServerProfile(currentTachyonServer));
      setRuntimeInputs((current) => runtimeWithTachyonServer(current, currentTachyonServer));
    }
  }, [currentTachyonServer]);

  useEffect(() => {
    if (subscription.nodes.length === 0) {
      setNodeLatencies({});
      return;
    }
    void refreshNodeLatencies(subscription.nodes, false);
  }, [subscription.nodes]);

  useEffect(() => {
    const unsub = telemetryClient.subscribe(setTelemetry);
    telemetryClient.connect();
    return () => {
      unsub();
      telemetryClient.disconnect();
    };
  }, [telemetryClient]);

  useEffect(() => {
    const xrayRunning = runtimeStatus?.xray.state === "running";
    if (!runtimeInputs.xrayStatsEnabled || !xrayRunning) {
      setXrayTrafficStats(emptyXrayTrafficStats());
      setXrayTrafficError(null);
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const stats = await getXrayTrafficStats();
        if (!cancelled) {
          setXrayTrafficStats(stats);
          setXrayTrafficError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setXrayTrafficError(error instanceof Error ? error.message : "Xray Stats query failed");
        }
      }
    };
    void poll();
    const timer = window.setInterval(
      () => void poll(),
      Math.max(runtimeInputs.tachyonTelemetryIntervalMs, 1000),
    );
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    runtimeInputs.tachyonTelemetryIntervalMs,
    runtimeInputs.xrayBinaryPath,
    runtimeInputs.xrayStatsEnabled,
    runtimeInputs.xrayStatsListen,
    runtimeInputs.xrayStatsPort,
    runtimeStatus?.xray.state,
  ]);

  useEffect(() => {
    if (!hasTrafficSource(trafficTotals)) {
      previousTrafficRef.current = null;
      setTrafficSamples([]);
      return;
    }
    const now = Date.now();
    const totals = trafficTotals;
    const previous = previousTrafficRef.current;
    previousTrafficRef.current = { at: now, totals };
    if (!previous) {
      return;
    }
    const sample = trafficRateSample(previous.totals, totals, now - previous.at);
    setTrafficSamples((current) => [...current, { ...sample, at: now }].slice(-34));
  }, [telemetry.latestTelemetry, trafficTotals]);

  const navItems: Array<{ icon: string; id: PrismView; label: string }> = [
    { icon: "⌘", id: "overview", label: ui.overview },
    { icon: "▰", id: "configs", label: ui.configs },
    { icon: "▣", id: "subscriptions", label: ui.subscriptions },
    { icon: "⬡", id: "plugins", label: ui.plugins },
    { icon: "⚙", id: "settings", label: ui.settings },
  ];

  return (
    <main className="prism-shell">
      <header
        className="app-titlebar"
        data-tauri-drag-region
        onMouseDown={startWindowDrag}
      >
        <div className="title-left" data-tauri-drag-region>
          <span className="app-cube">◆</span>
          <strong>Tachyon Prism v0.1.0</strong>
          <span>Rolling Preview</span>
        </div>
        <div className="title-drag-fill" data-tauri-drag-region />
        <div className="window-actions" aria-label={ui.windowControls} data-no-window-drag>
          <button
            aria-label={ui.pinWindow}
            aria-pressed={alwaysOnTop}
            className={alwaysOnTop ? "active" : ""}
            data-window-action="pin"
            type="button"
            onClick={() => void handleWindowAction("pin")}
          >
            ⌖
          </button>
          <button
            aria-label={ui.minimizeWindow}
            data-window-action="minimize"
            type="button"
            onClick={() => void handleWindowAction("minimize")}
          >
            −
          </button>
          <button
            aria-label={ui.maximizeUnavailable}
            data-window-action="maximize"
            disabled
            title={ui.fixedWindow}
            type="button"
          >
            □
          </button>
          <button
            aria-label={ui.closeWindow}
            className="close"
            data-window-action="close"
            type="button"
            onClick={() => void handleWindowAction("close")}
          >
            ×
          </button>
        </div>
      </header>

      <nav className="top-nav" aria-label={ui.primaryNavigation}>
        {navItems.map((item) => (
          <button
            aria-current={item.id === activeView ? "page" : undefined}
            className={item.id === activeView ? "top-nav-item active" : "top-nav-item"}
            key={item.id}
            type="button"
            onClick={() => navigateView(item.id)}
          >
            <span>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <section className="quick-strip" aria-label={ui.coreStatus}>
        <div className="mode-pills capability-pills">
          <button
            aria-pressed={systemProxyActive}
            className={systemProxyActive ? "pill capability-pill active" : "pill capability-pill"}
            disabled={!systemProxyInteractive}
            title={systemProxyReason}
            type="button"
            onClick={() => void toggleSystemProxy()}
          >
            <strong>{ui.systemProxy}</strong>
            <small>{systemProxyReason}</small>
          </button>
          <div
            className="capability-pill unavailable"
            data-capability="tun-runtime"
            role="status"
            title={ui.tunRuntimeUnavailable}
          >
            <strong>{ui.tunMode}</strong>
            <small>{ui.tunRuntimeUnavailable}</small>
          </div>
        </div>
        <div className="core-switches">
          <button
            aria-label={`${xrayRunning ? ui.stop : ui.start} Xray Core`}
            className={xrayRunning ? "core-switch running" : "core-switch stopped"}
            title={`${xrayRunning ? ui.stop : ui.start} Xray Core`}
            type="button"
            onClick={() => void toggleRuntime("xray")}
          >
            <span className="core-led" />
            <strong>Xray</strong>
            <small>{xrayRunning ? ui.runtimeOnline : ui.runtimeOffline}</small>
          </button>
          <button
            aria-label={`${tachyonRunning ? ui.stop : ui.start} Tachyon Core`}
            className={tachyonRunning ? "core-switch running" : "core-switch stopped"}
            title={`${tachyonRunning ? ui.stop : ui.start} Tachyon Core`}
            type="button"
            onClick={() => void toggleRuntime("tachyonCore")}
          >
            <span className="core-led" />
            <strong>Tachyon</strong>
            <small>{tachyonRunning ? ui.runtimeOnline : ui.runtimeOffline}</small>
          </button>
        </div>
        <button
          className={activeNode ? "quick-node active" : "quick-node"}
          title={activeNode ? nodeXrayCompatibilityTitle(activeNode, ui) : ui.noNodeSelected}
          type="button"
          onClick={() => setNodePickerOpen(true)}
        >
          <span className={activeNode && nodeAvailable(activeNode, nodeLatencies) ? "status-dot connected" : "status-dot checking"} />
          <span>
            <small>{ui.currentNode}</small>
            <strong>{activeNode?.name ?? ui.noNodeSelected}</strong>
          </span>
          <em>⌃</em>
        </button>
        <div className="strip-actions">
          <button
            aria-label={ui.coreSettings}
            title={ui.openCoreSettings}
            type="button"
            onClick={() => {
              setSettingsSection("core");
              navigateView("settings");
            }}
          >
            ⚙
          </button>
          <button aria-label={ui.save} title={ui.save} type="button" onClick={() => void saveDrafts()}>
            ◫
          </button>
          <button aria-label={ui.runProxyProbe} title={ui.runProxyProbe} type="button" onClick={() => void probeXrayProxy()}>
            ⌁
          </button>
          <button
            aria-label={ui.refresh}
            title={ui.refresh}
            type="button"
            onClick={() => {
              void refreshRuntime();
              void refreshRuntimePrivilege();
              void refreshSystemProxy();
            }}
          >
            ↻
          </button>
          <button
            aria-label={xrayRunning || tachyonRunning ? ui.stopAll : ui.startAll}
            title={xrayRunning || tachyonRunning ? ui.stopAll : ui.startAll}
            type="button"
            onClick={() => void (xrayRunning || tachyonRunning ? stopAllRuntime() : startAllRuntime())}
          >
            {xrayRunning || tachyonRunning ? "■" : "▶"}
          </button>
        </div>
      </section>

      <section className="prism-content">
        {activeView === "overview" ? (
          <OverviewView
            activeNode={activeNode}
            activeTachyonServer={currentTachyonServer}
            latencyMap={nodeLatencies}
            nodeCount={subscriptionNodeCount}
            onOpenNodePicker={() => setNodePickerOpen(true)}
            onOpenCoreSettings={() => {
              setSettingsSection("core");
              navigateView("settings");
            }}
            onProbeXray={() => void probeXrayProxy()}
            onRoutingModeChange={changeRoutingMode}
            routingMode={routingMode}
            telemetry={telemetry}
            trafficRates={trafficRates}
            trafficSamples={trafficSamples}
            trafficTotals={trafficTotals}
            xrayStatsEnabled={runtimeInputs.xrayStatsEnabled}
            xrayStatsError={xrayTrafficError}
            xrayStatsQueriedAt={xrayTrafficStats.queriedAt}
            xrayRunning={xrayRunning}
            xrayProbe={xrayProbe}
            tachyonRunning={tachyonRunning}
            ui={ui}
          />
        ) : null}

        {activeView === "configs" ? (
          <ConfigsView
            activeNode={activeNode}
            expandedGroupId={expandedPolicyGroupId}
            latencyMap={nodeLatencies}
            onChooseNode={chooseNode}
            onExpandGroup={setExpandedPolicyGroupId}
            onRefreshLatency={() => void refreshNodeLatencies()}
            onSetShowUnavailable={setShowUnavailableNodes}
            onSetSortByDelay={setSortPolicyNodesByDelay}
            onSetViewMode={setPolicyGroupViewMode}
            showUnavailable={showUnavailableNodes}
            sortByDelay={sortPolicyNodesByDelay}
            subscription={subscription}
            ui={ui}
            viewMode={policyGroupViewMode}
          />
        ) : null}

        {activeView === "subscriptions" ? (
          <SubscriptionsView
            activeNode={activeNode}
            currentSubscription={currentSubscription}
            latencyMap={nodeLatencies}
            nodeCount={subscriptionNodeCount}
            nameInputRef={subscriptionNameInputRef}
            onChooseNode={chooseNode}
            onChooseSubscription={chooseSubscription}
            onDeleteSubscription={deleteSubscription}
            onImportText={importSubscriptionText}
            onNameChange={setSubscriptionName}
            onPrepareAdd={prepareSubscriptionAdd}
            onRefreshLatency={() => void refreshNodeLatencies()}
            onTextChange={setSubscriptionText}
            onUpdate={() => void updateSubscriptionFromUrl()}
            onUpdateAll={() => void updateAllSubscriptions()}
            onUrlChange={setSubscriptionUrl}
            setViewMode={setSubscriptionViewMode}
            subscription={subscription}
            subscriptionName={subscriptionName}
            subscriptionText={subscriptionText}
            subscriptionUrl={subscriptionUrl}
            ui={ui}
            viewMode={subscriptionViewMode}
          />
        ) : null}

        {activeView === "plugins" ? (
          <PluginsView
            onCheckUpdates={checkPluginUpdates}
            onInstallAll={installAllPlugins}
            onInstall={installPlugin}
            onRun={runPlugin}
            onSource={showPluginSource}
            onToggle={togglePlugin}
            pluginState={pluginState}
            ui={ui}
          />
        ) : null}

        {activeView === "settings" ? (
          <SettingsView
            binaryBusy={binaryBusy}
            binaryInfo={binaryInfo}
            binaryReleases={binaryReleases}
            binarySourceInputs={binarySourceInputs}
            changeLanguage={changeLanguage}
            canonicalXrayAvailable={Boolean(canonicalXrayText)}
            canonicalXrayReadError={canonicalXrayLoadState === "error"}
            configPaths={configPaths}
            configuredStatusLabel={configuredStatusLabel}
            copyDraft={copyDraft}
            currentLanguage={language}
            drafts={drafts}
            generatedXrayDraft={generatedDrafts.xray}
            formatBytes={formatBytes}
            installBinary={installBinary}
            managedBinaries={managedBinaries}
            managedStatusLabel={managedStatusLabel}
            onAddManualProfile={() => void addManualProfile()}
            onAddSuggestion={(profile) => void addSuggestion(profile)}
            onCheckLatest={(kind) => void checkLatestRelease(kind)}
            onDiagnoseRelease={(kind) => void diagnoseCoreRelease(kind)}
            onDownloadLatest={(kind) => void downloadLatestRelease(kind)}
            onInstallWintun={() => void installWintun()}
            onRefreshBinaries={() => void refreshManagedBinaries()}
            onRefreshRuntime={() => {
              void refreshRuntime();
              void refreshRuntimePrivilege();
              void refreshSystemProxy();
            }}
            onRemoveProfile={(id) => void removeProfile(id)}
            onSaveTachyonServer={saveTachyonServerProfile}
            onSaveDrafts={() => void saveDrafts()}
            onSaveRuntime={() => void saveRuntimeInputs()}
            onScanSteam={() => void scanSteam()}
            onSectionChange={setSettingsSection}
            onStartRuntime={(kind) => void startRuntime(kind)}
            onStopRuntime={(kind) => void stopRuntime(kind)}
            onSelectTachyonServer={chooseTachyonServerProfile}
            onEditTachyonServer={editTachyonServerProfile}
            onDeleteTachyonServer={deleteTachyonServerProfile}
            onExportDiagnostics={() => void exportDiagnostics()}
            onExportAdvancedXray={exportAdvancedXray}
            onImportAdvancedXray={(file) => void importAdvancedXray(file)}
            onRestoreAdvancedXray={restoreAdvancedXray}
            onSetAdvancedXrayEnabled={setAdvancedXrayEnabled}
            onUpdateAdvancedXrayText={updateAdvancedXrayText}
            onUseManaged={(kind) => void useManagedBinary(kind)}
            onValidateConfigs={() => void validateAllConfigs()}
            profiles={profiles}
            releaseChannelForKind={releaseChannelForKind}
            releaseDiagnostics={releaseDiagnostics}
            runtimeInputs={runtimeInputs}
            runtimePaths={runtimePaths}
            runtimeRows={runtimeRows}
            runtimeStatus={runtimeStatus}
            section={settingsSection}
            setBinarySourceInputs={setBinarySourceInputs}
            setManualProfile={setManualProfile}
            setRuntimeInputs={setRuntimeInputs}
            setSteamRoot={setSteamRoot}
            suggestions={suggestions}
            tachyonServerDraft={tachyonServerDraft}
            tachyonServers={tachyonServers}
            ui={ui}
            validationResults={validationResults}
            xrayAdvancedEditor={xrayAdvancedEditor}
            manualProfile={manualProfile}
            steamRoot={steamRoot}
            systemProxy={systemProxy}
            setReleaseChannelForKind={setReleaseChannelForKind}
            setTachyonServerDraft={setTachyonServerDraft}
            launcherSettings={launcherSettings}
            updateSteamLauncherSetting={updateSteamLauncherSetting}
          />
        ) : null}
      </section>

      <footer className="bottom-status">
        <button type="button" onClick={() => setControllerOpen(true)}>{ui.controller}</button>
        <span>{message}</span>
      </footer>

      {controllerOpen ? (
        <ControllerDrawer
          activeNode={activeNode}
          expandedGroupId={expandedPolicyGroupId}
          latencyMap={nodeLatencies}
          onChooseNode={chooseNode}
          onClose={() => setControllerOpen(false)}
          onExpandGroup={setExpandedPolicyGroupId}
          onRefreshLatency={() => void refreshNodeLatencies()}
          onSetShowUnavailable={setShowUnavailableNodes}
          onSetSortByDelay={setSortPolicyNodesByDelay}
          onSetViewMode={setPolicyGroupViewMode}
          showUnavailable={showUnavailableNodes}
          sortByDelay={sortPolicyNodesByDelay}
          subscription={subscription}
          ui={ui}
          viewMode={policyGroupViewMode}
        />
      ) : null}

      {nodePickerOpen ? (
        <NodeDrawer
          activeNode={activeNode}
          latencyMap={nodeLatencies}
          onChooseNode={chooseNode}
          onClose={() => setNodePickerOpen(false)}
          subscription={subscription}
          ui={ui}
        />
      ) : null}
    </main>
  );
}

function OverviewView({
  activeNode,
  activeTachyonServer,
  latencyMap,
  nodeCount,
  onOpenNodePicker,
  onOpenCoreSettings,
  onProbeXray,
  onRoutingModeChange,
  routingMode,
  telemetry,
  trafficRates,
  trafficSamples,
  trafficTotals,
  xrayRunning,
  xrayProbe,
  xrayStatsEnabled,
  xrayStatsError,
  xrayStatsQueriedAt,
  tachyonRunning,
  ui,
}: {
  activeNode: ProxyNode | undefined;
  activeTachyonServer: TachyonServerProfile | undefined;
  latencyMap: NodeLatencyMap;
  nodeCount: number;
  onOpenNodePicker: () => void;
  onOpenCoreSettings: () => void;
  onProbeXray: () => void;
  onRoutingModeChange: (mode: XrayRoutingMode) => void;
  routingMode: XrayRoutingMode;
  telemetry: TelemetryState;
  trafficRates: TrafficSample;
  trafficSamples: TimedTrafficSample[];
  trafficTotals: TrafficTotals;
  xrayRunning: boolean;
  xrayProbe: XrayProbeStatus;
  xrayStatsEnabled: boolean;
  xrayStatsError: string | null;
  xrayStatsQueriedAt: number | null;
  tachyonRunning: boolean;
  ui: typeof zh;
}) {
  const width = 560;
  const height = 220;
  const plotHeight = 196;
  const chartPadding = 48;
  const trafficSeries = trafficSeriesFromSamples(trafficSamples, {
    tachyonDown: `${ui.tachyon} ↓`,
    tachyonUp: `${ui.tachyon} ↑`,
    xrayDown: `${ui.xray} ↓`,
    xrayUp: `${ui.xray} ↑`,
  });
  const rawMaxTraffic = Math.max(...trafficSeries.flatMap((item) => item.values), 0);
  const maxTraffic = Math.max(rawMaxTraffic, 1);
  const hasTrafficSamples = trafficSamples.length > 0 && hasTrafficSource(trafficTotals);
  const hasRealtimeTrafficSource = hasTrafficSource(trafficTotals);
  const activeConnectionsPrimary = trafficTotals.activeConnections.known
    ? String(trafficTotals.activeConnections.value ?? 0)
    : "--";
  const memoryPrimary = trafficTotals.memoryBytes.known
    ? formatBytes(trafficTotals.memoryBytes.value)
    : "--";
  const trafficSources: TrafficSourceBadge[] = [
    {
      detail: tachyonRunning
        ? telemetry.connection === "connected"
          ? ui.tachyonTelemetryActive
          : ui.tachyonTelemetryWaiting
        : ui.tachyonStopped,
      label: ui.tachyon,
      state: tachyonRunning
        ? telemetry.connection === "connected"
          ? "ok"
          : "checking"
        : "idle",
    },
    xrayStatsError
      ? {
          detail: xrayStatsError,
          label: ui.xray,
          state: "error",
        }
      : !xrayStatsEnabled
        ? {
            detail: ui.xrayStatsDisabled,
            label: ui.xray,
            state: "idle",
          }
        : !xrayRunning
          ? {
              detail: ui.xrayStopped,
              label: ui.xray,
              state: "idle",
            }
          : xrayStatsQueriedAt
            ? {
                detail: ui.xrayStatsActive,
                label: ui.xray,
                state: "ok",
              }
            : {
                detail: ui.xrayStatsWaiting,
                label: ui.xray,
                state: "checking",
              },
  ];
  const activeNodeLatency = activeNode ? nodeLatencyLabel(activeNode, ui, latencyMap) : "--";
  const activeNodeProtocol = activeNode ? activeNode.protocol.toUpperCase() : "--";
  const activeNodeTransport = activeNode?.transport || "udp";
  const activeNodeCompatibility = activeNode ? nodeXrayCompatibilityLabel(activeNode, ui) : "--";
  const activeNodeAvailable = activeNode ? nodeAvailable(activeNode, latencyMap) : false;
  const firstSampleAt = trafficSamples[0]?.at ?? null;
  const lastSampleAt = trafficSamples[trafficSamples.length - 1]?.at ?? null;
  const chartTimeLabel = (value: number | null) =>
    value
      ? new Date(value).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })
      : "--:--";

  return (
    <div className="overview-page page-enter">
      <div className="overview-metrics">
        <MetricCard
          label={ui.realTimeTraffic}
          primary={hasRealtimeTrafficSource ? `↑ ${formatRate(trafficRates.tachyonUp + trafficRates.xrayUp)}` : "--"}
          secondary={hasRealtimeTrafficSource ? `↓ ${formatRate(trafficRates.tachyonDown + trafficRates.xrayDown)}` : ui.metricUnknown}
        />
        <MetricCard
          label={ui.totalTraffic}
          primary={hasRealtimeTrafficSource ? `↑ ${formatBytes(trafficTotals.totalUp)}` : "--"}
          secondary={hasRealtimeTrafficSource ? `↓ ${formatBytes(trafficTotals.totalDown)}` : ui.metricUnknown}
        />
        <MetricCard
          label={ui.activeConnections}
          primary={activeConnectionsPrimary}
          secondary={trafficTotals.activeConnections.known ? ui.tgpSessions : ui.tachyonTelemetryWaiting}
        />
        <MetricCard
          label={ui.memory}
          primary={memoryPrimary}
          secondary={trafficTotals.memoryBytes.known ? "RSS" : ui.memoryNotExposed}
        />
      </div>

      <div className="runtime-presence">
        <div className={xrayRunning ? "runtime-presence-item running" : "runtime-presence-item stopped"}>
          <span className="core-led" />
          <strong>{ui.xray}</strong>
          <span>{xrayRunning ? ui.runtimeOnline : ui.runtimeOffline}</span>
        </div>
        <div className={tachyonRunning ? "runtime-presence-item running" : "runtime-presence-item stopped"}>
          <span className="core-led" />
          <strong>{ui.tachyon}</strong>
          <span>{tachyonRunning ? ui.runtimeOnline : ui.runtimeOffline}</span>
        </div>
        <div className="runtime-presence-server">
          <strong>{ui.tachyonServer}</strong>
          <span>
          {activeTachyonServer
            ? `${activeTachyonServer.name} (${tachyonServerEndpoint(activeTachyonServer)})`
            : ui.noTachyonServerProfiles}
          </span>
        </div>
        <button type="button" onClick={onOpenCoreSettings}>{ui.openCoreSettings}</button>
      </div>

      <div className="overview-grid">
        <section className="traffic-section">
          <h2>{ui.traffic}</h2>
          <article className="glass-card traffic-card">
            <div className="traffic-card-header">
              <div className="legend">
                {trafficSeries.map((series) => (
                  <span className={`legend-item ${series.className.replace(" ", "-")}`} key={series.label}>
                    <i /> {series.label}
                    <b>{formatRate(series.values[series.values.length - 1] ?? 0)}</b>
                  </span>
                ))}
              </div>
              <div className="traffic-source-list" aria-label={ui.trafficSource}>
                {trafficSources.map((source) => (
                  <span className={`traffic-source-pill ${source.state}`} key={`${source.label}-${source.state}`}>
                    <strong>{source.label}</strong>
                    <span>{source.detail}</span>
                  </span>
                ))}
              </div>
            </div>
            <svg className="traffic-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${ui.traffic} · ${ui.liveWindow}`}>
            {Array.from({ length: 7 }, (_, index) => (
              <g key={index}>
                <text className="chart-axis-label" x="4" y={Math.max(10, (plotHeight / 6) * index - 4)}>
                  {formatBytes(Math.round(((6 - index) / 6) * maxTraffic))}
                </text>
                <line
                  className="chart-grid"
                  x1="48"
                  x2={width}
                  y1={(plotHeight / 6) * index}
                  y2={(plotHeight / 6) * index}
                />
              </g>
            ))}
            {hasTrafficSamples ? (
              trafficSeries.map((series) => (
                <polyline
                  className={`traffic-line ${series.className}`}
                  key={series.label}
                  points={polyline(series.values, width, plotHeight, chartPadding, maxTraffic)}
                />
              ))
            ) : (
              <text className="chart-empty" x={width / 2} y={height / 2}>
                {ui.waitingTelemetry}
              </text>
            )}
            <text className="chart-time-label" x={chartPadding} y={height - 4}>
              {chartTimeLabel(firstSampleAt)}
            </text>
            <text className="chart-time-label end" x={width} y={height - 4}>
              {chartTimeLabel(lastSampleAt)}
            </text>
            </svg>
            {!hasTrafficSamples ? <p className="chart-empty-detail">{ui.trafficNoSamplesHint}</p> : null}
          </article>
        </section>

        <aside className="overview-side">
          <button
            className={activeNode ? "current-node-card active" : "current-node-card"}
            title={activeNode ? `${activeNodeCompatibility}: ${nodeXrayCompatibilityTitle(activeNode, ui)}` : ui.noNodeSelected}
            type="button"
            onClick={onOpenNodePicker}
          >
            <span className={activeNodeAvailable ? "status-dot connected" : "status-dot checking"} />
            <div>
              <strong>{ui.currentNode}</strong>
              <b>{activeNode?.name ?? ui.noNodeSelected}</b>
              <small>
                {activeNodeProtocol} :: {activeNodeTransport} · {activeNodeLatency} · {nodeCount} {ui.nodes}
              </small>
            </div>
            <em>⌄</em>
          </button>

          <article className={`proxy-probe-panel ${xrayProbe.state}`}>
            <header>
              <div>
                <strong>{ui.localProxyProbe}</strong>
                <span>
                  {xrayProbe.state === "running"
                    ? ui.proxyProbeRunning
                    : xrayProbe.state === "ok"
                      ? ui.proxyProbeOk
                      : xrayProbe.error || ui.proxyProbeIdle}
                </span>
              </div>
              <button
                disabled={!activeNode || !xrayRunning || xrayProbe.state === "running"}
                type="button"
                onClick={onProbeXray}
              >
                {ui.runProxyProbe}
              </button>
            </header>
            <div className="proxy-probe-grid">
              <ProxyProbeRow label="HTTP" result={xrayProbe.report?.http} />
              <ProxyProbeRow label="SOCKS" result={xrayProbe.report?.socks} />
            </div>
          </article>

          <h2>{ui.workMode}</h2>
          <div className="work-mode-list">
            <button
              aria-pressed={routingMode === "global"}
              className={routingMode === "global" ? "mode-option active" : "mode-option"}
              data-routing-mode="global"
              type="button"
              onClick={() => onRoutingModeChange("global")}
            >
              <strong>{ui.globalMode}</strong>
              <span>{ui.globalModeDesc}</span>
            </button>
            <button
              aria-pressed={routingMode === "rule"}
              className={routingMode === "rule" ? "mode-option active" : "mode-option"}
              data-routing-mode="rule"
              type="button"
              onClick={() => onRoutingModeChange("rule")}
            >
              <strong>{ui.rulesMode}</strong>
              <span>{ui.rulesModeDesc}</span>
            </button>
            <button
              aria-pressed={routingMode === "direct"}
              className={routingMode === "direct" ? "mode-option active" : "mode-option"}
              data-routing-mode="direct"
              type="button"
              onClick={() => onRoutingModeChange("direct")}
            >
              <strong>{ui.directMode}</strong>
              <span>{ui.directModeDesc}</span>
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  primary,
  secondary,
}: {
  label: string;
  primary: string;
  secondary: string;
}) {
  return (
    <article className="metric-card">
      <h2>{label}</h2>
      <strong>{primary}</strong>
      <span>{secondary}</span>
    </article>
  );
}

function ProxyProbeRow({
  label,
  result,
}: {
  label: string;
  result: ProxyProbeResult | undefined;
}) {
  const state = result ? (result.ok ? "ok" : "error") : "idle";
  return (
    <div className={`proxy-probe-row ${state}`}>
      <span>{label}</span>
      <strong>{proxyProbeSummary(result)}</strong>
      <small>{result?.via ?? "--"}</small>
    </div>
  );
}

function ConfigsView({
  activeNode,
  expandedGroupId,
  latencyMap,
  onChooseNode,
  onExpandGroup,
  onRefreshLatency,
  onSetShowUnavailable,
  onSetSortByDelay,
  onSetViewMode,
  showUnavailable,
  sortByDelay,
  subscription,
  ui,
  viewMode,
}: {
  activeNode: ProxyNode | undefined;
  expandedGroupId: string;
  latencyMap: NodeLatencyMap;
  onChooseNode: (id: string) => void;
  onExpandGroup: (id: string) => void;
  onRefreshLatency: () => void;
  onSetShowUnavailable: (value: boolean) => void;
  onSetSortByDelay: (value: boolean) => void;
  onSetViewMode: (mode: SubscriptionViewMode) => void;
  showUnavailable: boolean;
  sortByDelay: boolean;
  subscription: SubscriptionSnapshot;
  ui: typeof zh;
  viewMode: SubscriptionViewMode;
}) {
  const sortedNodes = useMemo(() => {
    const nodes = [...subscription.nodes];
    if (sortByDelay) {
      nodes.sort(
        (left, right) =>
          nodeLatencySortValue(left, latencyMap) - nodeLatencySortValue(right, latencyMap),
      );
    }
    return showUnavailable ? nodes : nodes.filter((node) => nodeAvailable(node, latencyMap));
  }, [latencyMap, showUnavailable, sortByDelay, subscription.nodes]);

  const activeName = activeNode?.name ?? ui.noNodeSelected;
  const activeProtocol = activeNode ? activeNode.protocol.toUpperCase() : "--";
  const activeChain = [ui.nodeSelector, ui.autoSelect, activeName];
  const groups: PolicyGroup[] = [
    {
      active: activeName,
      chain: activeChain,
      description: `${ui.selector} :: ${activeProtocol}`,
      icon: "🚀",
      id: "node-selector",
      nodes: sortedNodes,
      title: ui.nodeSelector,
      type: ui.selector,
    },
    {
      active: activeName,
      chain: [ui.urlTest, activeName],
      description: `${ui.autoSelect} :: ${sortByDelay ? ui.sortByDelay : ui.routeByRule}`,
      icon: "📍",
      id: "auto-select",
      nodes: sortedNodes,
      title: ui.autoSelect,
      type: ui.urlTest,
    },
    {
      active: "direct",
      chain: ["direct"],
      description: ui.directModeDesc,
      icon: "🎯",
      id: "global-direct",
      nodes: [],
      title: ui.globalDirect,
      type: ui.selector,
    },
    {
      active: "block",
      chain: ["block"],
      description: ui.directModeDesc,
      icon: "🛑",
      id: "global-block",
      nodes: [],
      title: ui.globalBlock,
      type: ui.selector,
    },
    {
      active: activeName,
      chain: activeChain,
      description: ui.routeByRule,
      icon: "🐟",
      id: "final-match",
      nodes: sortedNodes,
      title: ui.leakFish,
      type: ui.selector,
    },
  ];

  return (
    <div className="configs-page page-enter">
      <div className="config-toolbar">
        <div className="config-toolbar-left">
          <strong>{ui.policyGroups}</strong>
          <div className="mode-pills">
            <button className="toggle-pill" type="button" onClick={() => onSetShowUnavailable(!showUnavailable)}>
              <span className={showUnavailable ? "toggle-dot active" : "toggle-dot"} />
              {ui.showUnavailableNodes}
            </button>
            <button
              className={viewMode === "grid" ? "pill active" : "pill"}
              type="button"
              onClick={() => onSetViewMode(viewMode === "grid" ? "list" : "grid")}
            >
              {ui.cardMode}
            </button>
            <button className="toggle-pill" type="button" onClick={() => onSetSortByDelay(!sortByDelay)}>
              <span className={sortByDelay ? "toggle-dot active" : "toggle-dot"} />
              {ui.sortByDelay}
            </button>
            <button className="toolbar-square" type="button" title={ui.more}>
              ...
            </button>
          </div>
        </div>
        <div className="strip-actions">
          <button type="button" title={ui.filter}>⌯</button>
          <button type="button" title={ui.refreshLatency} onClick={onRefreshLatency}>↻</button>
          <button type="button" title={ui.collapseAll} onClick={() => onExpandGroup("")}>⌄</button>
        </div>
      </div>

      <div className="policy-stack" aria-label={ui.policyGroups}>
        {groups.map((group) => {
          const expanded = expandedGroupId === group.id;
          return (
            <article className={expanded ? "policy-group expanded" : "policy-group"} key={group.id}>
              <header>
                <button
                  className="policy-summary"
                  type="button"
                  onClick={() => onExpandGroup(expanded ? "" : group.id)}
                >
                  <span className="policy-icon">{group.icon}</span>
                  <span className="policy-copy">
                    <strong>
                      {group.title}
                      <small>{group.type}</small>
                      <small>::</small>
                      <em>{group.active}</em>
                    </strong>
                    <span>{group.chain.join(" / ")}</span>
                  </span>
                </button>
                <div className="panel-icons">
                  <button type="button" title={ui.filter}>⌯</button>
                  <button type="button" title={ui.refreshLatency} onClick={onRefreshLatency}>⏻</button>
                  <button type="button" onClick={() => onExpandGroup(expanded ? "" : group.id)}>
                    {expanded ? "⌄" : "›"}
                  </button>
                </div>
              </header>
              {expanded ? (
                <div className="policy-details">
                  <p>{group.description}</p>
                  {group.nodes.length > 0 ? (
                    <div className={viewMode === "grid" ? "node-card-grid" : "node-list-view"}>
                      {group.nodes.map((node) => (
                        <button
                          className={node.id === subscription.selectedNodeId ? "node-tile active" : "node-tile"}
                          key={`${group.id}-${node.id}`}
                          type="button"
                          onClick={() => onChooseNode(node.id)}
                        >
                          <strong>{node.name}</strong>
                          <span className={nodeAvailable(node, latencyMap) ? "" : "unavailable"}>
                            {nodeLatencyLabel(node, ui, latencyMap)}
                          </span>
                          <small>
                            {node.protocol.toUpperCase()} :: {node.transport || "udp"} / {nodeXrayCompatibilityLabel(node, ui)}
                          </small>
                          {node.id === subscription.selectedNodeId ? <em>✓</em> : null}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="virtual-route-grid">
                      <button className={group.id === "global-direct" ? "virtual-route active" : "virtual-route"} type="button">
                        <strong>direct</strong>
                        <span>{ui.directModeDesc}</span>
                      </button>
                      <button className={group.id === "global-block" ? "virtual-route active danger" : "virtual-route danger"} type="button">
                        <strong>block</strong>
                        <span>{ui.globalBlock}</span>
                      </button>
                    </div>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function SubscriptionsView({
  activeNode,
  currentSubscription,
  latencyMap,
  nameInputRef,
  nodeCount,
  onChooseNode,
  onChooseSubscription,
  onDeleteSubscription,
  onImportText,
  onNameChange,
  onPrepareAdd,
  onRefreshLatency,
  onTextChange,
  onUpdate,
  onUpdateAll,
  onUrlChange,
  setViewMode,
  subscription,
  subscriptionName,
  subscriptionText,
  subscriptionUrl,
  ui,
  viewMode,
}: {
  activeNode: ProxyNode | undefined;
  currentSubscription: SubscriptionProfile | undefined;
  latencyMap: NodeLatencyMap;
  nameInputRef: RefObject<HTMLInputElement | null>;
  nodeCount: number;
  onChooseNode: (id: string) => void;
  onChooseSubscription: (id: string) => void;
  onDeleteSubscription: (id: string) => void;
  onImportText: () => void;
  onNameChange: (value: string) => void;
  onPrepareAdd: () => void;
  onRefreshLatency: () => void;
  onTextChange: (value: string) => void;
  onUpdate: () => void;
  onUpdateAll: () => void;
  onUrlChange: (value: string) => void;
  setViewMode: (mode: SubscriptionViewMode) => void;
  subscription: SubscriptionSnapshot;
  subscriptionName: string;
  subscriptionText: string;
  subscriptionUrl: string;
  ui: typeof zh;
  viewMode: SubscriptionViewMode;
}) {
  return (
    <div className="subscriptions-page page-enter">
      <div className="section-toolbar">
        <div className="section-toolbar-start">
          <div className="section-heading">
            <h1>{ui.subscriptions}</h1>
            <p>{subscription.subscriptions.length} {ui.subscriptions} · {nodeCount} {ui.nodes}</p>
          </div>
          <div className="segmented">
            <button
              className={viewMode === "grid" ? "active" : ""}
              type="button"
              onClick={() => setViewMode("grid")}
            >
              {ui.grid}
            </button>
            <button
              className={viewMode === "list" ? "active" : ""}
              type="button"
              onClick={() => setViewMode("list")}
            >
              {ui.list}
            </button>
          </div>
        </div>
        <div className="toolbar-actions">
          <button type="button" onClick={onUpdateAll}>
            {ui.updateAll}
          </button>
          <button className="primary-action" type="button" onClick={onPrepareAdd}>
            + {ui.add}
          </button>
        </div>
      </div>

      <div className="subscription-layout">
        <aside className="subscription-column">
          <article className="glass-card add-sub-card">
            <h2>{ui.subscriptions}</h2>
            <input
              ref={nameInputRef}
              placeholder={ui.subscriptionName}
              value={subscriptionName}
              onChange={(event) => onNameChange(event.target.value)}
            />
            <input
              placeholder={ui.subscriptionUrl}
              value={subscriptionUrl}
              onChange={(event) => onUrlChange(event.target.value)}
            />
            <textarea
              placeholder={ui.subscriptionPayload}
              value={subscriptionText}
              onChange={(event) => onTextChange(event.target.value)}
            />
            <div className="row-actions">
              <button className="primary-action" type="button" onClick={onUpdate}>
                {ui.update}
              </button>
              <button type="button" onClick={onImportText}>
                {ui.import}
              </button>
            </div>
          </article>

          <div className="subscription-cards">
            {subscription.subscriptions.map((item) => (
              <article
                className={
                  item.id === subscription.selectedSubscriptionId
                    ? "subscription-card active"
                    : "subscription-card"
                }
                key={item.id}
              >
                <button type="button" onClick={() => onChooseSubscription(item.id)}>
                  <strong>{item.name}</strong>
                  <span>{item.nodes.length} {ui.nodes}</span>
                  <small>{item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "--"}</small>
                </button>
                <button type="button" onClick={() => onDeleteSubscription(item.id)}>
                  ...
                </button>
              </article>
            ))}
          </div>
        </aside>

        <article className="glass-card nodes-panel">
          <header>
            <div>
              <h2>{ui.nodeSelector}</h2>
              <p>
                {ui.selector} :: {currentSubscription?.name ?? "--"} / {activeNode?.name ?? "--"}
              </p>
            </div>
            <div className="panel-icons">
              <button type="button" title={ui.list} onClick={() => setViewMode(viewMode === "grid" ? "list" : "grid")}>⌯</button>
              <button type="button" title={ui.refreshLatency} onClick={onRefreshLatency}>↻</button>
              <button type="button" title={ui.nodeSelector} onClick={() => setViewMode("grid")}>⌄</button>
            </div>
          </header>
          <div className={viewMode === "grid" ? "node-card-grid" : "node-list-view"}>
            {subscription.nodes.map((node) => (
              <button
                className={node.id === subscription.selectedNodeId ? "node-tile active" : "node-tile"}
                key={node.id}
                type="button"
                onClick={() => onChooseNode(node.id)}
              >
                <strong>{node.name}</strong>
                <span className={nodeAvailable(node, latencyMap) ? "" : "unavailable"}>
                  {nodeLatencyLabel(node, ui, latencyMap)}
                </span>
                <small>
                  {node.protocol.toUpperCase()} :: {node.transport || "udp"} / {nodeXrayCompatibilityLabel(node, ui)}
                </small>
                {node.id === subscription.selectedNodeId ? <em>✓</em> : null}
              </button>
            ))}
          </div>
          {nodeCount === 0 ? <div className="empty-note">{ui.noSubscriptionNodes}</div> : null}
        </article>
      </div>
    </div>
  );
}

function PluginsView({
  onCheckUpdates,
  onInstall,
  onInstallAll,
  onRun,
  onSource,
  onToggle,
  pluginState,
  ui,
}: {
  onCheckUpdates: () => void;
  onInstall: (pluginId: string, pluginTitle: string) => void;
  onInstallAll: () => void;
  onRun: (pluginId: string, pluginTitle: string) => void;
  onSource: (pluginTitle: string) => void;
  onToggle: (pluginId: string, pluginTitle: string) => void;
  pluginState: PluginStateSnapshot;
  ui: typeof zh;
}) {
  const [filter, setFilter] = useState<PluginFilter>("all");
  const plugins = [
    {
      badge: "",
      desc: ui.pluginRollingDesc,
      id: pluginCatalogIds[0],
      tags: [ui.pluginTriggerManual, ui.pluginTriggerApp],
      title: ui.pluginRollingTitle,
    },
    {
      badge: "",
      desc: ui.pluginTransformDesc,
      id: pluginCatalogIds[1],
      tags: [ui.pluginTriggerManual, ui.pluginTriggerUpdate],
      title: ui.pluginTransformTitle,
    },
    {
      badge: "Dev",
      desc: ui.pluginStatsDesc,
      id: pluginCatalogIds[2],
      tags: [ui.pluginTriggerManual, ui.pluginTriggerApp],
      title: ui.pluginStatsTitle,
    },
    {
      badge: "●",
      desc: ui.pluginSwitchDesc,
      id: pluginCatalogIds[3],
      tags: [ui.pluginTriggerManual, ui.pluginTriggerNode],
      title: ui.pluginSwitchTitle,
    },
  ];
  const installed = installedPluginCount(pluginState);
  const enabled = enabledPluginCount(pluginState);
  const visiblePlugins = plugins.filter((plugin) => {
    const state = pluginState[plugin.id] ?? emptyPluginState();
    if (filter === "enabled") {
      return state.enabled;
    }
    if (filter === "installed") {
      return state.installed;
    }
    return true;
  });
  return (
    <div className="plugins-page page-enter">
      <div className="section-toolbar">
        <div className="section-toolbar-start">
          <div className="section-heading">
            <h1>{ui.pluginCenter}</h1>
            <p>{installed}/{plugins.length} {ui.installed} · {enabled}/{plugins.length} {ui.pluginEnabled}</p>
          </div>
          <div className="segmented">
            <button className={filter === "all" ? "active" : ""} type="button" onClick={() => setFilter("all")}>
              {ui.all}
            </button>
            <button className={filter === "installed" ? "active" : ""} type="button" onClick={() => setFilter("installed")}>
              {ui.installed}
            </button>
            <button className={filter === "enabled" ? "active" : ""} type="button" onClick={() => setFilter("enabled")}>
              {ui.pluginEnabled}
            </button>
          </div>
        </div>
        <div className="toolbar-actions">
          <button type="button" onClick={onCheckUpdates}>{ui.checkUpdates}</button>
          <button className="primary-action" type="button" onClick={onInstallAll}>
            + {ui.add}
          </button>
        </div>
      </div>
      <div className="plugin-card-grid">
        {visiblePlugins.map((plugin) => {
          const state = pluginState[plugin.id] ?? emptyPluginState();
          const status = !state.installed
            ? ui.pluginNotInstalled
            : state.enabled
              ? ui.pluginEnabled
              : ui.pluginDisabled;
          const lastRun = state.lastRunAt
            ? new Date(state.lastRunAt).toLocaleString()
            : ui.pluginNeverRun;
          return (
            <article
              className={state.enabled ? "plugin-rich-card active" : "plugin-rich-card"}
              key={plugin.id}
            >
              <header>
                <h2>
                  {plugin.badge === "Dev" ? <span className="dev-badge">Dev</span> : null}
                  {plugin.badge === "●" ? <span className="green-dot" /> : null}
                  {plugin.title}
                </h2>
                <button type="button" title={ui.more}>...</button>
              </header>
              <div className="tag-row">
                {plugin.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
                <span>{status}</span>
              </div>
              <p>{plugin.desc}</p>
              <div className="plugin-meta">
                <span>{ui.pluginRunCount}: {state.runCount}</span>
                <span>{ui.pluginLastRun}: {lastRun}</span>
              </div>
              <div className={`plugin-result ${state.lastRunStatus}`}>
                <span>{ui.pluginLastResult}</span>
                <strong>{state.lastResult || ui.pluginNoResult}</strong>
              </div>
              <footer>
                <button className="link-button" type="button" onClick={() => onSource(plugin.title)}>
                  {ui.source}
                </button>
                <div className="row-actions">
                  {state.installed ? (
                    <button type="button" onClick={() => onToggle(plugin.id, plugin.title)}>
                      {state.enabled ? ui.disable : ui.enable}
                    </button>
                  ) : (
                    <button type="button" onClick={() => onInstall(plugin.id, plugin.title)}>
                      {ui.install}
                    </button>
                  )}
                  <button
                    className="primary-action"
                    disabled={!state.installed || !state.enabled}
                    type="button"
                    onClick={() => onRun(plugin.id, plugin.title)}
                  >
                    ✨ {ui.run}
                  </button>
                </div>
              </footer>
            </article>
          );
        })}
        {visiblePlugins.length === 0 ? <div className="empty-note">{ui.pluginNoMatches}</div> : null}
      </div>
    </div>
  );
}

function SettingsView({
  binaryBusy,
  binaryInfo,
  binaryReleases,
  binarySourceInputs,
  changeLanguage,
  canonicalXrayAvailable,
  canonicalXrayReadError,
  configPaths,
  configuredStatusLabel,
  copyDraft,
  currentLanguage,
  drafts,
  generatedXrayDraft,
  formatBytes: formatBytesFn,
  installBinary,
  launcherSettings,
  managedBinaries,
  managedStatusLabel,
  manualProfile,
  onAddManualProfile,
  onAddSuggestion,
  onCheckLatest,
  onDiagnoseRelease,
  onDownloadLatest,
  onInstallWintun,
  onRefreshBinaries,
  onRefreshRuntime,
  onRemoveProfile,
  onSaveTachyonServer,
  onSaveDrafts,
  onSaveRuntime,
  onScanSteam,
  onSectionChange,
  onStartRuntime,
  onStopRuntime,
  onSelectTachyonServer,
  onEditTachyonServer,
  onDeleteTachyonServer,
  onExportDiagnostics,
  onExportAdvancedXray,
  onImportAdvancedXray,
  onRestoreAdvancedXray,
  onSetAdvancedXrayEnabled,
  onUpdateAdvancedXrayText,
  onUseManaged,
  onValidateConfigs,
  profiles,
  releaseChannelForKind: releaseChannelForKindFn,
  releaseDiagnostics,
  runtimeInputs,
  runtimePaths,
  runtimeRows,
  runtimeStatus,
  section,
  setBinarySourceInputs,
  setManualProfile,
  setReleaseChannelForKind: setReleaseChannelForKindFn,
  setRuntimeInputs,
  setSteamRoot,
  steamRoot,
  systemProxy,
  suggestions,
  tachyonServerDraft,
  tachyonServers,
  ui,
  updateSteamLauncherSetting,
  validationResults,
  xrayAdvancedEditor,
  setTachyonServerDraft,
}: {
  binaryBusy: boolean;
  binaryInfo: (kind: ManagedBinaryKind) => ManagedBinaryInfo | null;
  binaryReleases: Partial<Record<ManagedBinaryKind, RuntimeReleaseInfo>>;
  binarySourceInputs: Record<ManagedBinaryKind, string>;
  changeLanguage: (language: Language) => void;
  canonicalXrayAvailable: boolean;
  canonicalXrayReadError: boolean;
  configPaths: ConfigDraftPaths | null;
  configuredStatusLabel: (binary: ManagedBinaryInfo, ui: typeof zh) => string;
  copyDraft: (label: string, value: string) => Promise<void>;
  currentLanguage: Language;
  drafts: { core: string; error: string; xray: string };
  generatedXrayDraft: string;
  formatBytes: (value: number | null) => string;
  installBinary: (kind: ManagedBinaryKind) => Promise<void>;
  launcherSettings: LauncherSettings;
  managedBinaries: ManagedBinaryInventory | null;
  managedStatusLabel: (binary: ManagedBinaryInfo, ui: typeof zh) => string;
  manualProfile: typeof emptyProfile;
  onAddManualProfile: () => void;
  onAddSuggestion: (profile: GameProfile) => void;
  onCheckLatest: (kind: ManagedBinaryKind) => void;
  onDiagnoseRelease: (kind: ManagedBinaryKind) => void;
  onDownloadLatest: (kind: ManagedBinaryKind) => void;
  onInstallWintun: () => void;
  onRefreshBinaries: () => void;
  onRefreshRuntime: () => void;
  onRemoveProfile: (id: string) => void;
  onSaveTachyonServer: () => void;
  onSaveDrafts: () => void;
  onSaveRuntime: () => void;
  onScanSteam: () => void;
  onSectionChange: (section: SettingsSection) => void;
  onStartRuntime: (kind: ManagedBinaryKind) => void;
  onStopRuntime: (kind: ManagedBinaryKind) => void;
  onSelectTachyonServer: (id: string) => void;
  onEditTachyonServer: (profile: TachyonServerProfile) => void;
  onDeleteTachyonServer: (id: string) => void;
  onExportDiagnostics: () => void;
  onExportAdvancedXray: () => void;
  onImportAdvancedXray: (file: File | undefined) => void;
  onRestoreAdvancedXray: (useGenerated: boolean) => void;
  onSetAdvancedXrayEnabled: (enabled: boolean) => void;
  onUpdateAdvancedXrayText: (text: string) => void;
  onUseManaged: (kind: ManagedBinaryKind) => void;
  onValidateConfigs: () => void;
  profiles: GameProfile[];
  releaseChannelForKind: (settings: RuntimeSettings, kind: ManagedBinaryKind) => ReleaseChannel;
  releaseDiagnostics: Partial<Record<ManagedBinaryKind, CoreReleaseDiagnostics>>;
  runtimeInputs: RuntimeSettings;
  runtimePaths: RuntimePaths | null;
  runtimeRows: Array<{ label: string; value: string }>;
  runtimeStatus: RuntimeStatus | null;
  section: SettingsSection;
  setBinarySourceInputs: React.Dispatch<React.SetStateAction<typeof emptyBinarySourceInputs>>;
  setManualProfile: React.Dispatch<React.SetStateAction<typeof emptyProfile>>;
  setReleaseChannelForKind: (
    settings: RuntimeSettings,
    kind: ManagedBinaryKind,
    channel: ReleaseChannel,
  ) => RuntimeSettings;
  setRuntimeInputs: React.Dispatch<React.SetStateAction<RuntimeSettings>>;
  setSteamRoot: (value: string) => void;
  steamRoot: string;
  systemProxy: SystemProxyState | null;
  suggestions: GameProfile[];
  tachyonServerDraft: TachyonServerDraft;
  tachyonServers: TachyonServerSnapshot;
  ui: typeof zh;
  updateSteamLauncherSetting: <K extends keyof LauncherSettings["steam"]>(
    key: K,
    value: LauncherSettings["steam"][K],
  ) => void;
  validationResults: ValidationResults;
  xrayAdvancedEditor: XrayAdvancedEditorState;
  setTachyonServerDraft: React.Dispatch<React.SetStateAction<TachyonServerDraft>>;
}) {
  const sections: Array<{ id: SettingsSection; label: string }> = [
    { id: "general", label: ui.settingsGeneral },
    { id: "core", label: ui.coreSettings },
    { id: "rules", label: ui.rulesMode },
    { id: "plugins", label: ui.plugins },
    { id: "about", label: ui.settingsAbout },
  ];
  const coreRuntimeItems: Array<{
    kind: ManagedBinaryKind;
    label: string;
    path: string;
    status: ProcessStatus | undefined;
  }> = [
    {
      kind: "xray",
      label: "Xray Core",
      path: runtimeInputs.xrayBinaryPath,
      status: runtimeStatus?.xray,
    },
    {
      kind: "tachyonCore",
      label: "Tachyon Core",
      path: runtimeInputs.tachyonCoreBinaryPath,
      status: runtimeStatus?.tachyonCore,
    },
  ];
  return (
    <div className="settings-page page-enter">
      <aside className="settings-sidebar">
        {sections.map((item) => (
          <button
            className={section === item.id ? "active" : ""}
            key={item.id}
            type="button"
            onClick={() => onSectionChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </aside>
      <section className="settings-content">
        {section === "general" ? (
          <article className="settings-card">
            <h1>{ui.personalized}</h1>
            <SettingRow label={ui.theme}>
              <div className="segmented">
                <button className="active" type="button">{ui.dark}</button>
                <button type="button">{ui.light}</button>
                <button type="button">{ui.followSystem}</button>
              </div>
            </SettingRow>
            <SettingRow label={ui.color}>
              <div className="segmented">
                <button className="active" type="button">{ui.defaultColor}</button>
                <button type="button">{ui.green}</button>
                <button type="button">{ui.purple}</button>
                <button type="button">{ui.custom}</button>
              </div>
            </SettingRow>
            <SettingRow label={ui.language}>
              <div className="segmented">
                <button
                  className={currentLanguage === "zh-CN" ? "active" : ""}
                  type="button"
                  onClick={() => changeLanguage("zh-CN")}
                >
                  简体中文
                </button>
                <button
                  className={currentLanguage === "en" ? "active" : ""}
                  type="button"
                  onClick={() => changeLanguage("en")}
                >
                  English
                </button>
              </div>
            </SettingRow>
            <SettingRow label={ui.pageVisibility}>
              <div className="segmented wide">
                <button className="active" type="button">{ui.overview}</button>
                <button className="active" type="button">{ui.configs}</button>
                <button className="active" type="button">{ui.subscriptions}</button>
                <button type="button">{ui.ruleSets}</button>
                <button className="active" type="button">{ui.plugins}</button>
                <button type="button">{ui.scheduledTasks}</button>
              </div>
            </SettingRow>
            <SettingRow label={ui.behavior}>
              <label className="switch-line">
                <span>{ui.adminRestart}</span>
                <input type="checkbox" />
              </label>
            </SettingRow>
          </article>
        ) : null}

        {section === "core" ? (
          <div className="settings-stack">
            <article className="settings-card core-control-card">
              <header>
                <div>
                  <h1>{ui.coreControl}</h1>
                  <p>{ui.coreStatus}</p>
                </div>
                <div className="row-actions">
                  <button type="button" onClick={onSaveRuntime}>{ui.savePaths}</button>
                  <button type="button" onClick={onRefreshRuntime}>{ui.refresh}</button>
                </div>
              </header>
              <div className="core-control-grid">
                {coreRuntimeItems.map((item) => {
                  const running = item.status?.state === "running";
                  return (
                    <section className={running ? "core-control-item running" : "core-control-item stopped"} key={item.kind}>
                      <span className="core-led" />
                      <div>
                        <strong>{item.label}</strong>
                        <span>{running ? ui.runtimeOnline : ui.runtimeOffline}</span>
                        <small title={item.path}>{item.path || ui.notConfigured}</small>
                      </div>
                      <button
                        className={running ? "danger-action" : "primary-action"}
                        type="button"
                        onClick={() => running ? onStopRuntime(item.kind) : onStartRuntime(item.kind)}
                      >
                        {running ? ui.stop : ui.start}
                      </button>
                    </section>
                  );
                })}
              </div>
              <div className="capability-summary">
                <div className={systemProxy?.supported ? "capability-row available" : "capability-row unavailable"}>
                  <strong>{ui.systemProxy}</strong>
                  <span>
                    {!systemProxy
                      ? ui.capabilityChecking
                      : !systemProxy.supported
                        ? ui.capabilityUnavailable
                        : systemProxy.matchesPrism
                          ? ui.systemProxyEnabled
                          : systemProxy.enabled
                            ? ui.systemProxyOtherActive
                            : ui.systemProxyDisabled}
                  </span>
                  <small>
                    {systemProxy?.error ||
                      (systemProxy?.supported
                        ? systemProxy.matchesPrism
                          ? ui.systemProxyEnabled
                          : ui.systemProxyDisabled
                        : ui.systemProxyUnsupported)}
                  </small>
                </div>
                <div className="capability-row unavailable" data-capability="tun-runtime">
                  <strong>{ui.tunMode}</strong>
                  <span>{ui.capabilityUnavailable}</span>
                  <small>{ui.tunRuntimeUnavailable}</small>
                </div>
              </div>
            </article>

            <article className="settings-card diagnostics-export-card">
              <header>
                <div>
                  <h1>{ui.clientDiagnostics}</h1>
                  <p>{ui.clientDiagnosticsDesc}</p>
                </div>
                <button type="button" onClick={onExportDiagnostics}>{ui.exportDiagnostics}</button>
              </header>
              <div className="diagnostics-export-grid">
                <span>{ui.diagnosticsReadOnly}</span>
                <span>{ui.diagnosticsNoSpawn}</span>
                <span>{ui.diagnosticsNoProxy}</span>
                <span>{ui.diagnosticsNoTun}</span>
              </div>
              <p className="diagnostics-review-reminder">{ui.diagnosticsReviewReminder}</p>
            </article>

            <article className="settings-card">
              <header>
                <h1>{ui.runtime}</h1>
                <div className="row-actions">
                  <button type="button" onClick={onSaveRuntime}>{ui.savePaths}</button>
                  <button type="button" onClick={onRefreshBinaries}>{ui.refresh}</button>
                </div>
              </header>
              {runtimePaths ? (
                <div className="path-list">
                  <div><span>bin</span><strong>{displayPath(runtimePaths.binDir, ui)}</strong></div>
                  <div><span>runtime-settings.json</span><strong>{displayPath(runtimePaths.runtimeSettingsPath, ui)}</strong></div>
                </div>
              ) : null}
              <div className="runtime-list-mini">
                {runtimeRows.map((row) => (
                  <div key={row.label}><span>{row.label}</span><strong>{row.value}</strong></div>
                ))}
              </div>
              <div className="tachyon-server-panel">
                <header>
                  <div>
                    <h2>{ui.tachyonServerProfiles}</h2>
                    <p>{ui.tachyonServerProfileDesc}</p>
                  </div>
                  <button type="button" onClick={onSaveTachyonServer}>{ui.save}</button>
                </header>
                <div className="core-settings-grid">
                  <label>
                    <span>{ui.tachyonServerName}</span>
                    <input
                      placeholder="Game Relay"
                      value={tachyonServerDraft.name}
                      onChange={(event) =>
                        setTachyonServerDraft((current) => ({ ...current, name: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    <span>{ui.tachyonServerAddress}</span>
                    <input
                      placeholder="game.example.com"
                      value={tachyonServerDraft.address}
                      onChange={(event) =>
                        setTachyonServerDraft((current) => ({ ...current, address: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    <span>{ui.tachyonServerPort}</span>
                    <input
                      min={1}
                      max={65535}
                      type="number"
                      value={tachyonServerDraft.port}
                      onChange={(event) =>
                        setTachyonServerDraft((current) => ({ ...current, port: Number(event.target.value) }))
                      }
                    />
                  </label>
                  <label>
                    <span>{ui.tachyonTgpAuthPsk}</span>
                    <input
                      autoComplete="off"
                      placeholder="server.json: tgp.auth.psk"
                      type="password"
                      value={tachyonServerDraft.psk}
                      onChange={(event) =>
                        setTachyonServerDraft((current) => ({ ...current, psk: event.target.value }))
                      }
                    />
                    <small className="field-hint">{ui.tachyonTgpAuthPskDesc}</small>
                  </label>
                  <label className="wide-field">
                    <span>{ui.tachyonServerRemark}</span>
                    <input
                      placeholder={ui.tachyonServerRemark}
                      value={tachyonServerDraft.remark}
                      onChange={(event) =>
                        setTachyonServerDraft((current) => ({ ...current, remark: event.target.value }))
                      }
                    />
                  </label>
                </div>
                <div className="tachyon-server-list">
                  {tachyonServers.profiles.map((profile) => (
                    <article
                      className={
                        profile.id === tachyonServers.selectedProfileId
                          ? "tachyon-server-card active"
                          : "tachyon-server-card"
                      }
                      key={profile.id}
                    >
                      <button type="button" onClick={() => onSelectTachyonServer(profile.id)}>
                        <strong>{profile.name}</strong>
                        <span>{tachyonServerEndpoint(profile)}</span>
                        <small>{profile.remark || ui.tachyonServerNoRemark}</small>
                      </button>
                      <div className="row-actions">
                        <button type="button" onClick={() => onEditTachyonServer(profile)}>{ui.edit}</button>
                        <button type="button" onClick={() => onDeleteTachyonServer(profile.id)}>{ui.remove}</button>
                      </div>
                    </article>
                  ))}
                  {tachyonServers.profiles.length === 0 ? (
                    <div className="empty-note">{ui.noTachyonServerProfiles}</div>
                  ) : null}
                </div>
              </div>
              <div className="core-settings-grid">
                <label className="wide-field">
                  <span>{ui.tachyonLocalAddrs}</span>
                  <textarea
                    placeholder={"127.0.0.1:0\n192.168.1.10:0"}
                    value={runtimeInputs.tachyonLocalAddrs}
                    onChange={(event) =>
                      setRuntimeInputs((current) => ({ ...current, tachyonLocalAddrs: event.target.value }))
                    }
                  />
                </label>
                <label className="wide-field">
                  <span>{ui.tachyonConnectionMigration}</span>
                  <label className="mini-check">
                    <input
                      checked={runtimeInputs.tachyonConnectionMigration || runtimeInputs.tachyonMultipath}
                      disabled={runtimeInputs.tachyonMultipath}
                      type="checkbox"
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({
                          ...current,
                          tachyonConnectionMigration: event.target.checked,
                        }))
                      }
                    />
                    {ui.tachyonConnectionMigrationDesc}
                  </label>
                </label>
                <label className="wide-field">
                  <span>{ui.tachyonMultipath}</span>
                  <label className="mini-check">
                    <input
                      checked={runtimeInputs.tachyonMultipath}
                      type="checkbox"
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({
                          ...current,
                          tachyonMultipath: event.target.checked,
                          tachyonConnectionMigration: event.target.checked
                            ? true
                            : current.tachyonConnectionMigration,
                        }))
                      }
                    />
                    {ui.tachyonMultipathDesc}
                  </label>
                </label>
                <label>
                  <span>Xray SOCKS</span>
                  <div className="input-pair">
                    <input
                      value={runtimeInputs.xraySocksListen}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({ ...current, xraySocksListen: event.target.value }))
                      }
                    />
                    <input
                      min={1}
                      max={65535}
                      type="number"
                      value={runtimeInputs.xraySocksPort}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({ ...current, xraySocksPort: Number(event.target.value) }))
                      }
                    />
                  </div>
                </label>
                <label>
                  <span>Xray HTTP</span>
                  <div className="input-pair">
                    <input
                      value={runtimeInputs.xrayHttpListen}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({ ...current, xrayHttpListen: event.target.value }))
                      }
                    />
                    <input
                      min={1}
                      max={65535}
                      type="number"
                      value={runtimeInputs.xrayHttpPort}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({ ...current, xrayHttpPort: Number(event.target.value) }))
                      }
                    />
                  </div>
                </label>
                <label>
                  <span>Xray Stats API</span>
                  <div className="input-pair">
                    <input
                      value={runtimeInputs.xrayStatsListen}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({ ...current, xrayStatsListen: event.target.value }))
                      }
                    />
                    <input
                      min={1}
                      max={65535}
                      type="number"
                      value={runtimeInputs.xrayStatsPort}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({ ...current, xrayStatsPort: Number(event.target.value) }))
                      }
                    />
                  </div>
                </label>
                <label className="wide-field">
                  <span>System Proxy Bypass</span>
                  <input
                    value={runtimeInputs.systemProxyBypass}
                    onChange={(event) =>
                      setRuntimeInputs((current) => ({ ...current, systemProxyBypass: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Tachyon IPC</span>
                  <div className="input-pair">
                    <input
                      value={runtimeInputs.tachyonIpcListen}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({ ...current, tachyonIpcListen: event.target.value }))
                      }
                    />
                    <input
                      min={1}
                      max={65535}
                      type="number"
                      value={runtimeInputs.tachyonIpcPort}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({ ...current, tachyonIpcPort: Number(event.target.value) }))
                      }
                    />
                  </div>
                </label>
                <label>
                  <span>Tachyon gRPC</span>
                  <div className="input-pair">
                    <input
                      value={runtimeInputs.tachyonGrpcListen}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({ ...current, tachyonGrpcListen: event.target.value }))
                      }
                    />
                    <input
                      min={1}
                      max={65535}
                      type="number"
                      value={runtimeInputs.tachyonGrpcPort}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({ ...current, tachyonGrpcPort: Number(event.target.value) }))
                      }
                    />
                  </div>
                </label>
                <label>
                  <span>TUN</span>
                  <div className="input-pair">
                    <input
                      value={runtimeInputs.tachyonTunAddress}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({ ...current, tachyonTunAddress: event.target.value }))
                      }
                    />
                    <input
                      min={576}
                      max={9500}
                      type="number"
                      value={runtimeInputs.tachyonTunMtu}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({ ...current, tachyonTunMtu: Number(event.target.value) }))
                      }
                    />
                  </div>
                </label>
                <label className="wide-field">
                  <span>{ui.tachyonTunAutoRoute}</span>
                  <div className="capability-setting unavailable" data-capability="tun-auto-route">
                    <span>{ui.capabilityUnavailable}</span>
                    <small>{ui.tunSettingUnavailable}</small>
                  </div>
                </label>
                <label className="wide-field">
                  <span>{ui.tachyonTunDnsHijack}</span>
                  <div className="capability-setting unavailable" data-capability="tun-dns-hijack">
                    <span>{ui.capabilityUnavailable}</span>
                    <small>{ui.tunSettingUnavailable}</small>
                  </div>
                </label>
                <label>
                  <span>{ui.tachyonFecShards}</span>
                  <div className="input-pair">
                    <input
                      min={1}
                      max={32}
                      type="number"
                      value={runtimeInputs.tachyonFecDataShards}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({
                          ...current,
                          tachyonFecDataShards: Number(event.target.value),
                        }))
                      }
                    />
                    <input
                      min={0}
                      max={32}
                      type="number"
                      value={runtimeInputs.tachyonFecParityShards}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({
                          ...current,
                          tachyonFecParityShards: Number(event.target.value),
                        }))
                      }
                    />
                  </div>
                </label>
                <label>
                  <span>{ui.tachyonFecTiming}</span>
                  <div className="input-pair">
                    <input
                      min={1}
                      max={1000}
                      type="number"
                      value={runtimeInputs.tachyonFecGroupTimeoutMs}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({
                          ...current,
                          tachyonFecGroupTimeoutMs: Number(event.target.value),
                        }))
                      }
                    />
                    <input
                      min={1}
                      max={10000}
                      type="number"
                      value={runtimeInputs.tachyonFecAdaptWindow}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({
                          ...current,
                          tachyonFecAdaptWindow: Number(event.target.value),
                        }))
                      }
                    />
                  </div>
                </label>
                <label>
                  <span>Telemetry</span>
                  <div className="input-pair">
                    <input
                      min={100}
                      max={10000}
                      type="number"
                      value={runtimeInputs.tachyonTelemetryIntervalMs}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({
                          ...current,
                          tachyonTelemetryIntervalMs: Number(event.target.value),
                        }))
                      }
                    />
                    <label className="mini-check">
                      <input
                        checked={runtimeInputs.xrayStatsEnabled}
                        type="checkbox"
                        onChange={(event) =>
                          setRuntimeInputs((current) => ({
                            ...current,
                            xrayStatsEnabled: event.target.checked,
                          }))
                        }
                      />
                      Xray Stats
                    </label>
                  </div>
                </label>
                <label className="wide-field">
                  <span>{ui.tachyonAdaptiveFec}</span>
                  <label className="mini-check">
                    <input
                      checked={runtimeInputs.tachyonFecDynamic}
                      type="checkbox"
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({
                          ...current,
                          tachyonFecDynamic: event.target.checked,
                        }))
                      }
                    />
                    {ui.tachyonAdaptiveFecDesc}
                  </label>
                </label>
              </div>
              <div className="runtime-grid">
                <RuntimePathRow
                  label="Xray Core"
                  onStart={() => onStartRuntime("xray")}
                  onStop={() => onStopRuntime("xray")}
                  path={runtimeInputs.xrayBinaryPath}
                  setPath={(path) => setRuntimeInputs((current) => ({ ...current, xrayBinaryPath: path }))}
                  ui={ui}
                />
                <RuntimePathRow
                  label="Tachyon Core"
                  onStart={() => onStartRuntime("tachyonCore")}
                  onStop={() => onStopRuntime("tachyonCore")}
                  path={runtimeInputs.tachyonCoreBinaryPath}
                  setPath={(path) => setRuntimeInputs((current) => ({ ...current, tachyonCoreBinaryPath: path }))}
                  ui={ui}
                />
              </div>
            </article>

            <article className="settings-card">
              <header>
                <h1>{ui.binaries}</h1>
                <span>{managedBinaries?.binDir ?? "--"}</span>
              </header>
              <div className="binary-grid">
                {managedBinaryKinds.map((kind) => {
                  const binary = binaryInfo(kind);
                  const release = binaryReleases[kind];
                  const diagnostics = releaseDiagnostics[kind];
                  const sidecars = binary?.sidecarDependencies ?? [];
                  const missingWintun = sidecars.some(
                    (dependency) =>
                      dependency.required &&
                      !dependency.exists &&
                      dependency.name.toLowerCase() === "wintun.dll",
                  );
                  return (
                    <div className="binary-row" key={kind}>
                      <div className="binary-meta">
                        <strong>{binary?.displayName ?? managedBinaryDisplayName(kind)}</strong>
                        <span>{binary ? managedStatusLabel(binary, ui) : ui.binaryInventoryUnavailable}</span>
                        {binary ? <span>{configuredStatusLabel(binary, ui)}</span> : null}
                        {binary ? <span>{displayPath(binary.targetPath, ui)}</span> : null}
                        {sidecars.map((dependency) => (
                          <span
                            className={dependency.exists ? "sidecar-status ok" : "sidecar-status missing"}
                            key={`${kind}-${dependency.name}`}
                          >
                            {dependency.name}: {dependency.exists
                              ? "OK"
                              : templateValue(ui.dependencyMissing, "path", dependency.path)}
                          </span>
                        ))}
                        {release ? (
                          <span>{ui.latest} {release.tagName}: {release.assetName} / {formatBytesFn(release.assetSizeBytes)}</span>
                        ) : null}
                      </div>
                      <ReleaseDiagnosticsPanel
                        diagnostics={diagnostics}
                        formatBytes={formatBytesFn}
                        kind={kind}
                        selectedChannel={releaseChannelForKindFn(runtimeInputs, kind)}
                        ui={ui}
                      />
                      <input
                        placeholder={ui.sourceBinaryPath}
                        value={binarySourceInputs[kind]}
                        onChange={(event) =>
                          setBinarySourceInputs((current) => ({ ...current, [kind]: event.target.value }))
                        }
                      />
                      <label className="inline-select">
                        <span>{ui.releaseChannel}</span>
                        <select
                          value={releaseChannelForKindFn(runtimeInputs, kind)}
                          onChange={(event) =>
                            setRuntimeInputs((current) =>
                              setReleaseChannelForKindFn(current, kind, event.target.value as ReleaseChannel),
                            )
                          }
                        >
                          <option value="stable">{ui.releaseStable}</option>
                          <option value="preview">{ui.releasePreview}</option>
                        </select>
                      </label>
                      <div className="row-actions">
                        <button type="button" onClick={() => void installBinary(kind)}>{ui.install}</button>
                        <button type="button" onClick={() => onUseManaged(kind)}>{ui.useManaged}</button>
                        <button disabled={binaryBusy} type="button" onClick={() => onCheckLatest(kind)}>{ui.checkLatest}</button>
                        <button disabled={binaryBusy} type="button" onClick={() => onDiagnoseRelease(kind)}>{ui.diagnose}</button>
                        <button disabled={binaryBusy} type="button" onClick={() => onDownloadLatest(kind)}>{ui.installLatest}</button>
                        {kind === "tachyonCore" && missingWintun ? (
                          <button disabled={binaryBusy} type="button" onClick={onInstallWintun}>{ui.installWintun}</button>
                        ) : null}
                      </div>
                      <p className="diagnose-note">{ui.diagnoseNote}</p>
                    </div>
                  );
                })}
              </div>
            </article>

            <article className="settings-card">
              <header>
                <h1>{ui.configDrafts}</h1>
                <div className="row-actions">
                  <button type="button" onClick={onSaveDrafts}>{ui.save}</button>
                  <button type="button" onClick={onValidateConfigs}>{ui.validateConfigs}</button>
                  <button type="button" onClick={() => void copyDraft("Xray config", drafts.xray)}>{ui.copyXray}</button>
                  <button type="button" onClick={() => void copyDraft("Core config", drafts.core)}>{ui.copyCore}</button>
                </div>
              </header>
              {drafts.error ? <div className="inline-error">{drafts.error}</div> : null}
              <ValidationSummary results={validationResults} ui={ui} />
              {configPaths ? (
                <div className="path-list">
                  <div><span>client.json</span><strong>{displayPath(configPaths.coreConfigPath, ui)}</strong></div>
                  <div><span>xray-client.json</span><strong>{displayPath(configPaths.xrayConfigPath, ui)}</strong></div>
                </div>
              ) : null}
              <div className="config-grid">
                <div className="config-editor-pane xray-config-editor">
                  <div className="config-editor-heading">
                    <span>Xray</span>
                    <label className="mini-check">
                      <input
                        checked={xrayAdvancedEditor.enabled}
                        data-xray-advanced-toggle
                        type="checkbox"
                        onChange={(event) => onSetAdvancedXrayEnabled(event.currentTarget.checked)}
                      />
                      {ui.advancedXrayEnable}
                    </label>
                  </div>
                  <p className="field-hint">{ui.advancedXrayDescription}</p>
                  {canonicalXrayReadError ? (
                    <p className="xray-canonical-error" role="alert">
                      {ui.canonicalXrayReadFailed}
                    </p>
                  ) : null}
                  {xrayAdvancedEditor.enabled ? (
                    <div className="xray-editor-actions row-actions">
                      <label className="file-action-button">
                        {ui.advancedXrayImport}
                        <input
                          accept=".json,application/json"
                          data-xray-json-import
                          type="file"
                          onChange={(event) => {
                            onImportAdvancedXray(event.currentTarget.files?.[0]);
                            event.currentTarget.value = "";
                          }}
                        />
                      </label>
                      <button type="button" onClick={onExportAdvancedXray}>{ui.advancedXrayExport}</button>
                      <button
                        disabled={!canonicalXrayAvailable}
                        type="button"
                        onClick={() => onRestoreAdvancedXray(false)}
                      >
                        {ui.advancedXrayRestore}
                      </button>
                      <button
                        disabled={!generatedXrayDraft}
                        type="button"
                        onClick={() => onRestoreAdvancedXray(true)}
                      >
                        {ui.advancedXrayRestoreGenerated}
                      </button>
                    </div>
                  ) : null}
                  <textarea
                    aria-label={ui.advancedXrayConfig}
                    data-config-draft="xray"
                    data-xray-advanced-editor={xrayAdvancedEditor.enabled ? "enabled" : "disabled"}
                    readOnly={!xrayAdvancedEditor.enabled}
                    spellCheck={false}
                    value={drafts.xray}
                    onChange={(event) => onUpdateAdvancedXrayText(event.currentTarget.value)}
                  />
                </div>
                <label className="config-editor-pane">
                  <span>Core</span>
                  <textarea data-config-draft="core" readOnly value={drafts.core} />
                </label>
              </div>
            </article>
          </div>
        ) : null}

        {section === "rules" ? (
          <div className="settings-stack">
            <article className="settings-card">
              <header>
                <h1>{ui.gameMode}</h1>
                <button type="button" onClick={onAddManualProfile}>{ui.addProgram}</button>
              </header>
              <div className="form-grid">
                <input
                  placeholder={ui.displayName}
                  value={manualProfile.displayName}
                  onChange={(event) => setManualProfile((current) => ({ ...current, displayName: event.target.value }))}
                />
                <input
                  placeholder={ui.processName}
                  value={manualProfile.processName}
                  onChange={(event) => setManualProfile((current) => ({ ...current, processName: event.target.value }))}
                />
                <input
                  className="wide-input"
                  placeholder={ui.executablePath}
                  value={manualProfile.executablePath}
                  onChange={(event) => setManualProfile((current) => ({ ...current, executablePath: event.target.value }))}
                />
              </div>
              <div className="profile-list">
                {profiles.map((profile) => (
                  <div className="profile-row" key={profile.id}>
                    <div><strong>{profile.displayName}</strong><span>{profileMatchLabel(profile)}</span></div>
                    <button type="button" onClick={() => onRemoveProfile(profile.id)}>{ui.remove}</button>
                  </div>
                ))}
              </div>
            </article>

            <article className="settings-card">
              <header>
                <h1>{ui.launchers}</h1>
                <button type="button" onClick={onScanSteam}>{ui.scanSteam}</button>
              </header>
              <input
                className="full-input"
                placeholder={ui.steamRoot}
                value={steamRoot}
                onChange={(event) => setSteamRoot(event.target.value)}
              />
              <label className="switch-line">
                <span>{ui.steamLauncherDetection}</span>
                <input
                  checked={launcherSettings.steam.enabled}
                  type="checkbox"
                  onChange={(event) => updateSteamLauncherSetting("enabled", event.currentTarget.checked)}
                />
              </label>
              <label className="switch-line">
                <span>{ui.steamChildTracking}</span>
                <input
                  checked={launcherSettings.steam.trackChildProcesses}
                  disabled={!launcherSettings.steam.enabled}
                  type="checkbox"
                  onChange={(event) => updateSteamLauncherSetting("trackChildProcesses", event.currentTarget.checked)}
                />
              </label>
              <div className="profile-list">
                {suggestions.map((profile) => (
                  <div className="profile-row" key={profile.id}>
                    <div><strong>{profile.displayName}</strong><span>{profileMatchLabel(profile)}</span></div>
                    <button type="button" onClick={() => onAddSuggestion(profile)}>{ui.add}</button>
                  </div>
                ))}
              </div>
            </article>
          </div>
        ) : null}

        {section === "plugins" ? (
          <article className="settings-card">
            <h1>{ui.pluginSettings}</h1>
            <SettingRow label={ui.pluginAutoUpdate}>
              <input type="checkbox" />
            </SettingRow>
            <SettingRow label={ui.pluginAllowNodeRead}>
              <input type="checkbox" />
            </SettingRow>
          </article>
        ) : null}

        {section === "about" ? (
          <article className="settings-card">
            <h1>Tachyon Prism</h1>
            <p>{ui.aboutDescription}</p>
          </article>
        ) : null}
      </section>
    </div>
  );
}

function ValidationSummary({ results, ui }: { results: ValidationResults; ui: typeof zh }) {
  const rows: Array<{ kind: ManagedBinaryKind; label: string }> = [
    { kind: "xray", label: "Xray" },
    { kind: "tachyonCore", label: "Tachyon Core" },
  ];
  if (!results.xray && !results.tachyonCore) {
    return null;
  }
  return (
    <div className="validation-summary">
      {rows.map(({ kind, label }) => {
        const result = results[kind];
        if (!result) {
          return null;
        }
        return (
          <div className={result.ok ? "ok" : "error"} key={kind}>
            <span>{label}</span>
            <strong>{result.ok ? "OK" : ui.validationFailed}</strong>
            <small title={result.command}>{result.error || result.details}</small>
          </div>
        );
      })}
    </div>
  );
}

function ReleaseDiagnosticsPanel({
  diagnostics,
  formatBytes: formatBytesFn,
  kind,
  selectedChannel,
  ui,
}: {
  diagnostics: CoreReleaseDiagnostics | undefined;
  formatBytes: (value: number | null) => string;
  kind: ManagedBinaryKind;
  selectedChannel: ReleaseChannel;
  ui: typeof zh;
}) {
  const snapshot = diagnostics ?? emptyReleaseDiagnostics(kind, selectedChannel);
  const display = buildReleaseDiagnosticsDisplay(snapshot, formatBytesFn);
  const labels: Record<string, string> = {
    Asset: ui.releaseAsset,
    Channel: ui.releaseChannel,
    Checksum: ui.checksum,
    "Installed path": ui.installedPath,
    "Installed version": ui.installedVersion,
    "Resolved tag": ui.resolvedTag,
  };
  const values: Record<string, string> = {
    Match: ui.checksumMatch,
    Mismatch: ui.checksumMismatch,
    "No compatible asset": ui.noCompatibleAsset,
    "Not checked": ui.checksumNotChecked,
    "Not installed": ui.notInstalled,
    "Not probed - diagnostics does not execute installed binaries": ui.notProbed,
    Pre: ui.releasePreview,
    Stable: ui.releaseStable,
    Unknown: ui.metricUnknown,
  };
  return (
    <div className="release-diagnostics">
      {display.rows.map((row) => (
        <div className={row.wide ? "wide" : undefined} key={row.label}>
          <span>{labels[row.label] ?? row.label}</span>
          <strong className={row.tone} title={row.title}>{values[row.value] ?? row.value}</strong>
        </div>
      ))}
      {display.lastError ? <p className="diagnostic-error">{display.lastError}</p> : null}
    </div>
  );
}

function SettingRow({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="setting-row">
      <strong>{label}</strong>
      <div>{children}</div>
    </div>
  );
}

function RuntimePathRow({
  label,
  onStart,
  onStop,
  path,
  setPath,
  ui,
}: {
  label: string;
  onStart: () => void;
  onStop: () => void;
  path: string;
  setPath: (value: string) => void;
  ui: typeof zh;
}) {
  return (
    <div className="runtime-row">
      <div>
        <strong>{label}</strong>
        <span>{path || ui.notConfigured}</span>
      </div>
      <input value={path} onChange={(event) => setPath(event.target.value)} />
      <div className="row-actions">
        <button type="button" onClick={onStart}>{ui.start}</button>
        <button type="button" onClick={onStop}>{ui.stop}</button>
      </div>
    </div>
  );
}

function ControllerDrawer({
  activeNode,
  expandedGroupId,
  latencyMap,
  onChooseNode,
  onClose,
  onExpandGroup,
  onRefreshLatency,
  onSetShowUnavailable,
  onSetSortByDelay,
  onSetViewMode,
  showUnavailable,
  sortByDelay,
  subscription,
  ui,
  viewMode,
}: {
  activeNode: ProxyNode | undefined;
  expandedGroupId: string;
  latencyMap: NodeLatencyMap;
  onChooseNode: (id: string) => void;
  onClose: () => void;
  onExpandGroup: (id: string) => void;
  onRefreshLatency: () => void;
  onSetShowUnavailable: (value: boolean) => void;
  onSetSortByDelay: (value: boolean) => void;
  onSetViewMode: (mode: SubscriptionViewMode) => void;
  showUnavailable: boolean;
  sortByDelay: boolean;
  subscription: SubscriptionSnapshot;
  ui: typeof zh;
  viewMode: SubscriptionViewMode;
}) {
  return (
    <div className="controller-backdrop">
      <section className="controller-panel" aria-label={ui.controller}>
        <ConfigsView
          activeNode={activeNode}
          expandedGroupId={expandedGroupId}
          latencyMap={latencyMap}
          onChooseNode={onChooseNode}
          onExpandGroup={onExpandGroup}
          onRefreshLatency={onRefreshLatency}
          onSetShowUnavailable={onSetShowUnavailable}
          onSetSortByDelay={onSetSortByDelay}
          onSetViewMode={onSetViewMode}
          showUnavailable={showUnavailable}
          sortByDelay={sortByDelay}
          subscription={subscription}
          ui={ui}
          viewMode={viewMode}
        />
      </section>
      <button className="controller-close" type="button" onClick={onClose}>×</button>
    </div>
  );
}

function NodeDrawer({
  activeNode,
  latencyMap,
  onChooseNode,
  onClose,
  subscription,
  ui,
}: {
  activeNode: ProxyNode | undefined;
  latencyMap: NodeLatencyMap;
  onChooseNode: (id: string) => void;
  onClose: () => void;
  subscription: SubscriptionSnapshot;
  ui: typeof zh;
}) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <section className="node-drawer" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>🚀 {ui.nodeSelector}</h2>
            <p>{ui.selector} :: {activeNode?.name ?? "--"}</p>
          </div>
          <button type="button" onClick={onClose}>×</button>
        </header>
        <div className="node-card-grid">
          {subscription.nodes.map((node) => (
            <button
              className={node.id === subscription.selectedNodeId ? "node-tile active" : "node-tile"}
              key={node.id}
              type="button"
              onClick={() => onChooseNode(node.id)}
            >
              <strong>{node.name}</strong>
              <span className={nodeAvailable(node, latencyMap) ? "" : "unavailable"}>
                {nodeLatencyLabel(node, ui, latencyMap)}
              </span>
              <small>{node.protocol.toUpperCase()} :: {node.transport || "udp"} / {nodeXrayCompatibilityLabel(node, ui)}</small>
              {node.id === subscription.selectedNodeId ? <em>✓</em> : null}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
