import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  buildCoreClientConfigDraft,
  buildXrayClientConfigDraft,
  stringifyDraft,
  type XrayRoutingMode,
} from "./domain/configDrafts";
import {
  getConfigPaths,
  saveConfigDraft,
  saveConfigDrafts,
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
  getManagedBinaries,
  getRuntimePrivilegeStatus,
  getRuntimePaths,
  getRuntimeSettings,
  getRuntimeStatus,
  getSystemProxyStatus,
  getXrayTrafficStats,
  disableSystemProxy,
  enableSystemProxy,
  installLatestTachyonCore,
  installLatestXray,
  installManagedBinary,
  installWintunSidecar,
  saveRuntimeSettings,
  startTachyonCore,
  startXray,
  stopTachyonCore,
  stopXray,
  testTcpLatency,
  testXrayProxy,
  validateTachyonCoreConfig,
  validateXrayConfig,
  type ConfigValidationResult,
  type ManagedBinaryInfo,
  type ManagedBinaryInventory,
  type ManagedBinaryKind,
  type ProcessStatus,
  type ReleaseChannel,
  type RuntimePaths,
  type RuntimePrivilegeStatus,
  type RuntimeReleaseInfo,
  type RuntimeSettings,
  type RuntimeStatus,
  type SystemProxyState,
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
} from "./domain/subscriptions";
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
import type { TelemetryData, TelemetryState } from "./domain/telemetry";
import { invokeDesktop, isTauriRuntime } from "./domain/tauri";

type ConnectionState = "checking" | "connected" | "disconnected";
type PrismView = "overview" | "configs" | "subscriptions" | "plugins" | "settings";
type SettingsSection = "general" | "core" | "rules" | "plugins" | "about";
type ReadinessState = "error" | "ok" | "warning";
type SubscriptionViewMode = "grid" | "list";
type ValidationResults = Partial<Record<ManagedBinaryKind, ConfigValidationResult>>;

const prismViews: PrismView[] = ["overview", "configs", "subscriptions", "plugins", "settings"];
const routingModeStorageKey = "tachyon.prism.routingMode.v1";

interface ReadinessItem {
  detail: string;
  label: string;
  state: ReadinessState;
}

interface TrafficSample {
  tachyonDown: number;
  tachyonUp: number;
  xrayDown: number;
  xrayUp: number;
}

interface TrafficTotals {
  tachyonDown: number;
  tachyonUp: number;
  totalDown: number;
  totalUp: number;
  xrayDown: number;
  xrayUp: number;
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
  addProgram: "添加程序",
  autoSelect: "自动选择",
  cardMode: "卡片模式",
  binaries: "核心文件",
  checkLatest: "检查更新",
  collapseAll: "收起全部",
  configDrafts: "配置草稿",
  configs: "配置",
  controller: "控制器",
  coreSettings: "核心",
  currentNode: "当前节点",
  directMode: "直连",
  directModeDesc: "直接连接所有流量",
  download: "下载",
  enabledProfiles: "启用规则",
  globalMode: "全局",
  import: "导入",
  install: "安装",
  installLatest: "安装最新版",
  installWintun: "安装 Wintun",
  language: "语言",
  launchers: "启动器",
  list: "列表",
  memory: "内存",
  nodeSelector: "节点选择",
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
  startAllPartial: "Xray Core {xray} / Tachyon Core {tachyon}",
  runtimeStarted: "已启动",
  runtimeFailed: "启动失败",
  stop: "停止",
  stopAll: "停止全部",
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
  allowPluginNodeAccess: "允许插件读取节点",
  autoUpdatePlugins: "自动更新插件",
  behavior: "行为",
  checkUpdates: "检查更新",
  color: "颜色",
  copyCore: "复制 Core",
  copyXray: "复制 Xray",
  validateConfigs: "验证配置",
  custom: "自定义",
  dark: "深色",
  defaultColor: "默认",
  displayName: "显示名称",
  downloadRate: "下载速率",
  executablePath: "可执行文件路径",
  expand: "展开",
  filter: "筛选",
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
  more: "更多",
  noNodeSelected: "未选择节点",
  noSubscriptionNodes: "还没有订阅节点",
  notConfigured: "未配置",
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
  ready: "Ready",
  recentRoutes: "最近路由",
  releaseChannel: "发布通道",
  refreshLatency: "刷新延迟",
  routeByRule: "按规则和进程自动选择出口",
  ruleSets: "规则集",
  run: "运行",
  scheduledTasks: "计划任务",
  selector: "Selector",
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
  theme: "主题",
  totalTraffic: "总流量",
  tunMode: "TUN模式",
  unavailable: "不可用",
  uploadRate: "上传速率",
  urlTest: "URLTest",
  waitingTelemetry: "等待遥测流...",
  xrayStatsActive: "Stats 已连接",
  xrayStatsDisabled: "Stats 已关闭",
  xrayStatsError: "Stats 错误",
  xrayStatsWaiting: "等待 Stats",
  xrayStopped: "Xray 未运行",
  tachyonTelemetryActive: "遥测已连接",
  tachyonTelemetryWaiting: "等待遥测",
  workMode: "工作模式",
};

const en: typeof zh = {
  activeConnections: "Active",
  add: "Add",
  addProgram: "Add Program",
  autoSelect: "Auto Select",
  cardMode: "Card Mode",
  binaries: "Binaries",
  checkLatest: "Check Latest",
  collapseAll: "Collapse All",
  configDrafts: "Config Drafts",
  configs: "Config",
  controller: "Controller",
  coreSettings: "Core",
  currentNode: "Current Node",
  directMode: "Direct",
  directModeDesc: "Direct all traffic",
  download: "Download",
  enabledProfiles: "Enabled Rules",
  globalMode: "Global",
  import: "Import",
  install: "Install",
  installLatest: "Install Latest",
  installWintun: "Install Wintun",
  language: "Language",
  launchers: "Launchers",
  list: "List",
  memory: "Memory",
  nodeSelector: "Node Selector",
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
  startAllPartial: "Xray Core {xray} / Tachyon Core {tachyon}",
  runtimeStarted: "started",
  runtimeFailed: "failed",
  stop: "Stop",
  stopAll: "Stop All",
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
  allowPluginNodeAccess: "Allow plugins to read nodes",
  autoUpdatePlugins: "Auto-update plugins",
  behavior: "Behavior",
  checkUpdates: "Check Updates",
  color: "Color",
  copyCore: "Copy Core",
  copyXray: "Copy Xray",
  validateConfigs: "Validate Configs",
  custom: "Custom",
  dark: "Dark",
  defaultColor: "Default",
  displayName: "Display name",
  downloadRate: "Download rate",
  executablePath: "Executable path",
  expand: "Expand",
  filter: "Filter",
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
  more: "More",
  noNodeSelected: "No node selected",
  noSubscriptionNodes: "No subscription nodes yet",
  notConfigured: "Not configured",
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
  refreshLatency: "Refresh Latency",
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
  theme: "Theme",
  totalTraffic: "Total Traffic",
  tunMode: "TUN Mode",
  unavailable: "Unavailable",
  uploadRate: "Upload rate",
  urlTest: "URLTest",
  waitingTelemetry: "Waiting for telemetry stream...",
  xrayStatsActive: "Stats connected",
  xrayStatsDisabled: "Stats disabled",
  xrayStatsError: "Stats error",
  xrayStatsWaiting: "Waiting for Stats",
  xrayStopped: "Xray stopped",
  tachyonTelemetryActive: "Telemetry connected",
  tachyonTelemetryWaiting: "Waiting telemetry",
  workMode: "Work Mode",
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
  const measured = latencyMap[node.id];
  return !measured || Boolean(measured.ok && measured.latencyMs !== null);
}

function nodeLatencyLabel(node: ProxyNode, ui: typeof zh, latencyMap: NodeLatencyMap): string {
  const measured = latencyMap[node.id];
  if (measured && !measured.ok) {
    return ui.unavailable;
  }
  const latency = nodeLatency(node, latencyMap);
  return latency === null ? "--" : `${latency}ms`;
}

function processStatusLabel(status: ProcessStatus | undefined): string {
  if (!status) {
    return "unknown";
  }
  return status.pid ? `${status.state} pid ${status.pid}` : status.state;
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
  return status.canManageTun ? "ready" : "needs admin";
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

function managedStatusLabel(binary: ManagedBinaryInfo): string {
  return binary.managedExists ? `installed, ${formatBytes(binary.managedSizeBytes)}` : "not installed";
}

function configuredStatusLabel(binary: ManagedBinaryInfo): string {
  return binary.configuredExists ? "configured path exists" : "configured path missing";
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

function draftText(
  activeNode: ProxyNode | undefined,
  profiles: GameProfile[],
  launcherSettings: LauncherSettings,
  routingMode: XrayRoutingMode,
  runtimeSettings: RuntimeSettings,
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
        tgpServerAddr: runtimeSettings.tachyonTgpServerAddress,
        tunAddress: runtimeSettings.tachyonTunAddress,
        tunAutoRoute: runtimeSettings.tachyonTunAutoRoute,
        tunDnsHijack: runtimeSettings.tachyonTunDnsHijack,
        tunMtu: runtimeSettings.tachyonTunMtu,
      }),
    );
  } catch (error) {
    coreError = error instanceof Error ? error.message : "Tachyon Core config generation failed";
  }

  try {
    if (!activeNode) {
      throw new Error("Select an Xray subscription node before generating Xray config");
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
    xrayError = error instanceof Error ? error.message : "Xray config generation failed";
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

function telemetryBytes(data: TelemetryData | null, xrayStats: XrayTrafficStats): TrafficTotals {
  if (!data && !xrayStats.queriedAt && xrayStats.bytesSent === 0 && xrayStats.bytesReceived === 0) {
    return emptyTrafficTotals();
  }
  const tachyonUp = data?.tgp_bytes_sent ?? data?.bytes_tgp ?? 0;
  const tachyonDown = data?.tgp_bytes_received ?? 0;
  const xrayUp = xrayStats.bytesSent || data?.xray_bytes_sent || 0;
  const xrayDown = xrayStats.bytesReceived || data?.xray_bytes_received || 0;
  return {
    tachyonDown,
    tachyonUp,
    totalDown: tachyonDown + xrayDown,
    totalUp: tachyonUp + xrayUp,
    xrayDown,
    xrayUp,
  };
}

function emptyTrafficTotals(): TrafficTotals {
  return {
    tachyonDown: 0,
    tachyonUp: 0,
    totalDown: 0,
    totalUp: 0,
    xrayDown: 0,
    xrayUp: 0,
  };
}

function isEmptyTrafficTotals(totals: TrafficTotals): boolean {
  return (
    totals.tachyonDown === 0 &&
    totals.tachyonUp === 0 &&
    totals.totalDown === 0 &&
    totals.totalUp === 0 &&
    totals.xrayDown === 0 &&
    totals.xrayUp === 0
  );
}

function emptyTrafficSample(): TrafficSample {
  return {
    tachyonDown: 0,
    tachyonUp: 0,
    xrayDown: 0,
    xrayUp: 0,
  };
}

function emptyXrayTrafficStats(): XrayTrafficStats {
  return {
    bytesReceived: 0,
    bytesSent: 0,
    queriedAt: null,
  };
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

function trafficRateSample(previous: TrafficTotals, current: TrafficTotals, elapsedMs: number): TrafficSample {
  const seconds = Math.max(elapsedMs / 1000, 0.1);
  return {
    tachyonDown: rateDelta(previous.tachyonDown, current.tachyonDown, seconds),
    tachyonUp: rateDelta(previous.tachyonUp, current.tachyonUp, seconds),
    xrayDown: rateDelta(previous.xrayDown, current.xrayDown, seconds),
    xrayUp: rateDelta(previous.xrayUp, current.xrayUp, seconds),
  };
}

function rateDelta(previous: number, current: number, seconds: number): number {
  return Math.max(0, current - previous) / seconds;
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
  const [policyGroupViewMode, setPolicyGroupViewMode] = useState<SubscriptionViewMode>("grid");
  const [pluginState, setPluginState] = useState<PluginStateSnapshot>(() =>
    loadPluginState(pluginCatalogIds),
  );
  const [routingMode, setRoutingMode] = useState<XrayRoutingMode>(loadRoutingMode);
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
  const [validationResults, setValidationResults] = useState<ValidationResults>({});
  const [binaryBusy, setBinaryBusy] = useState(false);
  const [message, setMessage] = useState("Ready");
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryState>(() => ({
    connection: "disconnected",
    hello: null,
    latestTelemetry: null,
    recentRoutes: [],
    recentErrors: [],
  }));
  const telemetryClient = useMemo(() => new TelemetryClient(), []);
  const [xrayTrafficStats, setXrayTrafficStats] = useState<XrayTrafficStats>(emptyXrayTrafficStats);
  const [xrayTrafficError, setXrayTrafficError] = useState<string | null>(null);
  const [trafficSamples, setTrafficSamples] = useState<TrafficSample[]>([]);
  const previousTrafficRef = useRef<{ at: number; totals: TrafficTotals } | null>(null);
  const subscriptionNameInputRef = useRef<HTMLInputElement | null>(null);
  const t = useMemo(() => createTranslator(language), [language]);
  const ui = language === "zh-CN" ? zh : en;
  const currentSubscription = useMemo(() => activeSubscription(subscription), [subscription]);
  const subscriptionNodeCount = useMemo(() => totalSubscriptionNodes(subscription), [subscription]);
  const activeProfiles = useMemo(
    () => profiles.filter((profile) => profile.enabled).length,
    [profiles],
  );
  const activeNode = useMemo(() => selectedNode(subscription), [subscription]);
  const drafts = useMemo(
    () => draftText(activeNode, profiles, launcherSettings, routingMode, runtimeInputs),
    [activeNode, launcherSettings, profiles, routingMode, runtimeInputs],
  );
  const trafficTotals = useMemo(
    () => telemetryBytes(telemetry.latestTelemetry, xrayTrafficStats),
    [telemetry.latestTelemetry, xrayTrafficStats],
  );
  const trafficRates = trafficSamples[trafficSamples.length - 1] ?? emptyTrafficSample();
  const readinessItems = useMemo<ReadinessItem[]>(() => {
    const items: ReadinessItem[] = [];
    items.push(
      activeNode
        ? {
            detail: `${activeNode.name} (${activeNode.protocol.toUpperCase()})`,
            label: "Xray node",
            state: "ok",
          }
        : {
            detail: "Import a subscription or select a node before starting Xray.",
            label: "Xray node",
            state: "warning",
          },
    );
    items.push(
      runtimeInputs.tachyonServerAddress.trim()
        ? {
            detail: runtimeInputs.tachyonTgpServerAddress.trim() || runtimeInputs.tachyonServerAddress.trim(),
            label: "Tachyon server",
            state: "ok",
          }
        : {
            detail: "Configure a Tachyon TGP server before starting Tachyon Core.",
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
      runtimePrivilege?.canManageTun
        ? {
            detail: runtimePrivilege.message,
            label: "TUN privilege",
            state: "ok",
          }
        : {
            detail:
              runtimePrivilege?.message ||
              "Privilege status is unknown. Refresh runtime status before starting TUN mode.",
            label: "TUN privilege",
            state: runtimePrivilege ? "error" : "warning",
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
    managedBinaries,
    runtimePrivilege,
    runtimeInputs.tachyonCoreBinaryPath,
    runtimeInputs.tachyonServerAddress,
    runtimeInputs.tachyonTgpServerAddress,
    runtimeInputs.xrayBinaryPath,
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

  function changeRoutingMode(mode: XrayRoutingMode) {
    setRoutingMode(mode);
    saveRoutingMode(mode);
    setMessage(templateValue(ui.routingModeSelected, "mode", routingModeLabel(mode, ui)));
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
        const totals = telemetryBytes(telemetry.latestTelemetry, stats);
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

  async function writeDrafts(kind: ManagedBinaryKind | "all" = "all"): Promise<ConfigDraftPaths> {
    if (kind === "xray") {
      if (!drafts.xray) {
        throw new Error(drafts.xrayError || "No Xray config draft available");
      }
      const paths = await saveConfigDraft("xray", drafts.xray);
      setConfigPaths(paths);
      return paths;
    }

    if (kind === "tachyonCore") {
      if (!drafts.core) {
        throw new Error(drafts.coreError || "No Tachyon Core config draft available");
      }
      const paths = await saveConfigDraft("core", drafts.core);
      setConfigPaths(paths);
      return paths;
    }

    if (!drafts.core && !drafts.xray) {
      throw new Error(drafts.error || ui.noConfigDraftAvailable);
    }
    if (!drafts.core) {
      const paths = await saveConfigDraft("xray", drafts.xray);
      setConfigPaths(paths);
      return paths;
    }
    if (!drafts.xray) {
      const paths = await saveConfigDraft("core", drafts.core);
      setConfigPaths(paths);
      return paths;
    }
    const paths = await saveConfigDrafts(drafts.core, drafts.xray);
    setConfigPaths(paths);
    return paths;
  }

  async function saveDrafts() {
    try {
      await writeDrafts();
      setMessage(ui.configFilesSaved);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed");
    }
  }

  async function runConfigValidation(
    kind: ManagedBinaryKind,
    paths: ConfigDraftPaths,
    settings: RuntimeSettings,
    announce = true,
  ): Promise<ConfigValidationResult> {
    const result =
      kind === "xray"
        ? await validateXrayConfig(settings.xrayBinaryPath, paths.xrayConfigPath)
        : await validateTachyonCoreConfig(settings.tachyonCoreBinaryPath, paths.coreConfigPath);
    setValidationResults((current) => ({ ...current, [kind]: result }));
    if (!result.ok) {
      throw new Error(result.error || `${managedBinaryDisplayName(kind)} config validation failed`);
    }
    if (announce) {
      setMessage(`${managedBinaryDisplayName(kind)} config validated`);
    }
    return result;
  }

  async function validateAllConfigs() {
    try {
      const paths = await writeDrafts("all");
      const settings = await saveRuntimeSettings(runtimeInputs);
      setRuntimeInputs(settings);
      const results: ConfigValidationResult[] = [];
      if (drafts.xray) {
        results.push(await runConfigValidation("xray", paths, settings, false));
      }
      if (drafts.core) {
        results.push(await runConfigValidation("tachyonCore", paths, settings, false));
      }
      const ok = results.length > 0 && results.every((result) => result.ok);
      setMessage(ok ? ui.configsValidated : ui.configsValidationErrors);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Config validation failed");
    }
  }

  async function saveRuntimeInputs() {
    try {
      const settings = await saveRuntimeSettings(runtimeInputs);
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
      const settings = await saveRuntimeSettings(runtimeInputs);
      setRuntimeInputs(settings);
      const release =
        kind === "xray" ? await getLatestXrayRelease() : await getLatestTachyonCoreRelease();
      setBinaryReleases((current) => ({ ...current, [kind]: release }));
      setMessage(`${releaseChannelForKind(settings, kind)} ${managedBinaryDisplayName(kind)} ${release.tagName}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${managedBinaryDisplayName(kind)} release check failed`);
    } finally {
      setBinaryBusy(false);
    }
  }

  async function downloadLatestRelease(kind: ManagedBinaryKind) {
    try {
      setBinaryBusy(true);
      const settings = await saveRuntimeSettings(runtimeInputs);
      setRuntimeInputs(settings);
      const result =
        kind === "xray" ? await installLatestXray() : await installLatestTachyonCore();
      setBinaryReleases((current) => ({ ...current, [kind]: result.release }));
      setManagedBinaries(result.inventory);
      setRuntimeInputs(result.inventory.runtimeSettings);
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
      const settings = await saveRuntimeSettings(runtimeInputs);
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
    try {
      if (systemProxy?.matchesPrism) {
        const state = await disableSystemProxy();
        setSystemProxy(state);
        setMessage("System proxy disabled");
        return;
      }

      const settings = await saveRuntimeSettings(runtimeInputs);
      setRuntimeInputs(settings);
      const status = await getRuntimeStatus();
      setRuntimeStatus(status);
      if (status.xray.state !== "running") {
        const started = await startRuntime("xray");
        if (!started) {
          return;
        }
      }
      const state = await enableSystemProxy();
      setSystemProxy(state);
      setMessage(state.matchesPrism ? "System proxy enabled" : "System proxy update pending");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "System proxy update failed");
    }
  }

  async function probeXrayProxy() {
    try {
      const settings = await saveRuntimeSettings(runtimeInputs);
      setRuntimeInputs(settings);
      const status = await getRuntimeStatus();
      setRuntimeStatus(status);
      if (status.xray.state !== "running") {
        setMessage("Start Xray first, then run proxy probe");
        return;
      }
      setMessage("Testing local Xray HTTP proxy...");
      const result = await testXrayProxy();
      const latency = result.latencyMs === null ? "n/a" : `${result.latencyMs}ms`;
      if (result.ok) {
        setMessage(`Proxy OK: HTTP ${result.statusCode ?? "?"} / ${latency}`);
      } else {
        setMessage(result.error ?? "Proxy probe failed");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Proxy probe failed");
    }
  }

  async function startRuntime(kind: ManagedBinaryKind): Promise<boolean> {
    try {
      if (kind === "tachyonCore") {
        const privilege = runtimePrivilege ?? (await refreshRuntimePrivilege());
        if (privilege && !privilege.canManageTun) {
          throw new Error(privilege.message);
        }
      }
      const paths = await writeDrafts(kind);
      const settings = await saveRuntimeSettings(runtimeInputs);
      setRuntimeInputs(settings);
      await runConfigValidation(kind, paths, settings, false);
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
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Start failed");
      return false;
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
    const xrayStarted = await startRuntime("xray");
    const tachyonStarted = await startRuntime("tachyonCore");
    await refreshRuntime();
    if (xrayStarted && tachyonStarted) {
      setMessage(ui.startAllComplete);
    } else if (xrayStarted || tachyonStarted) {
      setMessage(
        templateValues(ui.startAllPartial, {
          xray: xrayStarted ? ui.runtimeStarted : ui.runtimeFailed,
          tachyon: tachyonStarted ? ui.runtimeStarted : ui.runtimeFailed,
        }),
      );
    }
  }

  async function stopAllRuntime() {
    try {
      if (systemProxy?.matchesPrism) {
        const proxy = await disableSystemProxy();
        setSystemProxy(proxy);
      }
    } catch {
      // Continue stopping subprocesses even if proxy cleanup fails.
    }
    await stopRuntime("xray");
    await stopRuntime("tachyonCore");
    await refreshRuntime();
    await refreshSystemProxy();
  }

  async function handleWindowAction(action: "pin" | "minimize" | "maximize" | "close") {
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
      if (action === "maximize") {
        const maximized = await invokeDesktop<boolean>("window_set_maximized", {
          value: !windowMaximized,
        });
        setWindowMaximized(maximized);
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

  function handleTitlebarDoubleClick(event: React.MouseEvent<HTMLElement>) {
    if (titlebarDragBlocked(event.target)) {
      return;
    }
    void handleWindowAction("maximize");
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
    if (!telemetry.latestTelemetry && isEmptyTrafficTotals(trafficTotals)) {
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
    setTrafficSamples((current) => [...current, sample].slice(-34));
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
        onDoubleClick={handleTitlebarDoubleClick}
        onMouseDown={startWindowDrag}
      >
        <div className="title-left" data-tauri-drag-region>
          <span className="app-cube">◆</span>
          <strong>Tachyon Prism v0.1.0</strong>
          <span>Rolling Preview</span>
        </div>
        <div className="title-drag-fill" data-tauri-drag-region />
        <div className="window-actions" aria-label="Window controls">
          <button
            aria-label="Pin window"
            aria-pressed={alwaysOnTop}
            className={alwaysOnTop ? "active" : ""}
            type="button"
            onClick={() => void handleWindowAction("pin")}
          >
            ⌖
          </button>
          <button
            aria-label="Minimize window"
            type="button"
            onClick={() => void handleWindowAction("minimize")}
          >
            −
          </button>
          <button
            aria-label="Maximize window"
            aria-pressed={windowMaximized}
            className={windowMaximized ? "active" : ""}
            type="button"
            onClick={() => void handleWindowAction("maximize")}
          >
            □
          </button>
          <button
            aria-label="Close window"
            className="close"
            type="button"
            onClick={() => void handleWindowAction("close")}
          >
            ×
          </button>
        </div>
      </header>

      <nav className="top-nav" aria-label="Primary">
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

      <section className="quick-strip">
        <div className="mode-pills">
          <button
            aria-pressed={Boolean(systemProxy?.matchesPrism)}
            className={systemProxy?.matchesPrism ? "pill active" : "pill"}
            type="button"
            onClick={() => void toggleSystemProxy()}
          >
            {ui.systemProxy}
          </button>
          <button
            aria-pressed={runtimeStatus?.tachyonCore.state === "running"}
            className={runtimeStatus?.tachyonCore.state === "running" ? "pill active" : "pill"}
            type="button"
            onClick={() => void toggleRuntime("tachyonCore")}
          >
            {ui.tunMode}
          </button>
        </div>
        <div className="strip-actions">
          <button
            aria-label={ui.coreSettings}
            type="button"
            onClick={() => {
              setSettingsSection("core");
              navigateView("settings");
            }}
          >
            ⚙
          </button>
          <button type="button" onClick={() => void saveDrafts()}>
            ◫
          </button>
          <button aria-label="Test Xray proxy" type="button" onClick={() => void probeXrayProxy()}>
            HTTP
          </button>
          <button
            type="button"
            onClick={() => {
              void refreshRuntime();
              void refreshRuntimePrivilege();
              void refreshSystemProxy();
            }}
          >
            ↻
          </button>
          <button type="button" onClick={() => void stopAllRuntime()}>
            ◎
          </button>
        </div>
      </section>

      <section className="prism-content">
        {activeView === "overview" ? (
          <OverviewView
            nodeCount={subscriptionNodeCount}
            onRoutingModeChange={changeRoutingMode}
            routingMode={routingMode}
            telemetry={telemetry}
            trafficRates={trafficRates}
            trafficSamples={trafficSamples}
            trafficTotals={trafficTotals}
            xrayStatsEnabled={runtimeInputs.xrayStatsEnabled}
            xrayStatsError={xrayTrafficError}
            xrayStatsQueriedAt={xrayTrafficStats.queriedAt}
            xrayRunning={runtimeStatus?.xray.state === "running"}
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
            configPaths={configPaths}
            configuredStatusLabel={configuredStatusLabel}
            copyDraft={copyDraft}
            currentLanguage={language}
            drafts={drafts}
            formatBytes={formatBytes}
            installBinary={installBinary}
            managedBinaries={managedBinaries}
            managedStatusLabel={managedStatusLabel}
            onAddManualProfile={() => void addManualProfile()}
            onAddSuggestion={(profile) => void addSuggestion(profile)}
            onCheckLatest={(kind) => void checkLatestRelease(kind)}
            onDownloadLatest={(kind) => void downloadLatestRelease(kind)}
            onInstallWintun={() => void installWintun()}
            onRefreshBinaries={() => void refreshManagedBinaries()}
            onRemoveProfile={(id) => void removeProfile(id)}
            onSaveDrafts={() => void saveDrafts()}
            onSaveRuntime={() => void saveRuntimeInputs()}
            onScanSteam={() => void scanSteam()}
            onSectionChange={setSettingsSection}
            onStartRuntime={(kind) => void startRuntime(kind)}
            onStopRuntime={(kind) => void stopRuntime(kind)}
            onUseManaged={(kind) => void useManagedBinary(kind)}
            onValidateConfigs={() => void validateAllConfigs()}
            profiles={profiles}
            releaseChannelForKind={releaseChannelForKind}
            runtimeInputs={runtimeInputs}
            runtimePaths={runtimePaths}
            runtimeRows={runtimeRows}
            section={settingsSection}
            setBinarySourceInputs={setBinarySourceInputs}
            setManualProfile={setManualProfile}
            setRuntimeInputs={setRuntimeInputs}
            setSteamRoot={setSteamRoot}
            suggestions={suggestions}
            ui={ui}
            validationResults={validationResults}
            manualProfile={manualProfile}
            steamRoot={steamRoot}
            setReleaseChannelForKind={setReleaseChannelForKind}
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
  nodeCount,
  onRoutingModeChange,
  routingMode,
  telemetry,
  trafficRates,
  trafficSamples,
  trafficTotals,
  xrayRunning,
  xrayStatsEnabled,
  xrayStatsError,
  xrayStatsQueriedAt,
  ui,
}: {
  nodeCount: number;
  onRoutingModeChange: (mode: XrayRoutingMode) => void;
  routingMode: XrayRoutingMode;
  telemetry: TelemetryState;
  trafficRates: TrafficSample;
  trafficSamples: TrafficSample[];
  trafficTotals: TrafficTotals;
  xrayRunning: boolean;
  xrayStatsEnabled: boolean;
  xrayStatsError: string | null;
  xrayStatsQueriedAt: number | null;
  ui: typeof zh;
}) {
  const width = 560;
  const height = 220;
  const chartPadding = 48;
  const trafficSeries = [
    { className: "tachyon up", label: "Tachyon ↑", values: trafficSamples.map((item) => item.tachyonUp) },
    { className: "tachyon down", label: "Tachyon ↓", values: trafficSamples.map((item) => item.tachyonDown) },
    { className: "xray up", label: "Xray ↑", values: trafficSamples.map((item) => item.xrayUp) },
    { className: "xray down", label: "Xray ↓", values: trafficSamples.map((item) => item.xrayDown) },
  ];
  const maxTraffic = Math.max(...trafficSeries.flatMap((item) => item.values), 1);
  const hasTrafficSamples = trafficSamples.length > 0 && maxTraffic > 0;
  const trafficSources: TrafficSourceBadge[] = [
    {
      detail: telemetry.connection === "connected" ? ui.tachyonTelemetryActive : ui.tachyonTelemetryWaiting,
      label: ui.tachyon,
      state: telemetry.connection === "connected" ? "ok" : "checking",
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

  return (
    <div className="overview-page page-enter">
      <div className="overview-metrics">
        <MetricCard label={ui.realTimeTraffic} primary={`↑ ${formatRate(trafficRates.tachyonUp + trafficRates.xrayUp)}`} secondary={`↓ ${formatRate(trafficRates.tachyonDown + trafficRates.xrayDown)}`} />
        <MetricCard label={ui.totalTraffic} primary={`↑ ${formatBytes(trafficTotals.totalUp)}`} secondary={`↓ ${formatBytes(trafficTotals.totalDown)}`} />
        <MetricCard label={ui.activeConnections} primary={`${telemetry.latestTelemetry?.tgp_sessions ?? 0}`} secondary={`${nodeCount} nodes`} />
        <MetricCard label={ui.memory} primary={`${telemetry.latestTelemetry?.goroutines ?? 0}`} secondary="goroutines" />
      </div>

      <div className="overview-grid">
        <section className="traffic-section">
          <h2>{ui.traffic}</h2>
          <article className="glass-card traffic-card">
            <div className="traffic-card-header">
              <div className="legend">
                {trafficSeries.map((series) => (
                  <span className={`legend-item ${series.className.replace(" ", "-")}`} key={series.label}>
                    ● {series.label}
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
            <svg className="traffic-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Traffic chart">
            {Array.from({ length: 7 }, (_, index) => (
              <g key={index}>
                <text className="chart-axis-label" x="4" y={Math.max(10, (height / 6) * index - 4)}>
                  {formatBytes(Math.round(((6 - index) / 6) * maxTraffic))}
                </text>
                <line
                  className="chart-grid"
                  x1="48"
                  x2={width}
                  y1={(height / 6) * index}
                  y2={(height / 6) * index}
                />
              </g>
            ))}
            {hasTrafficSamples ? (
              trafficSeries.map((series) => (
                <polyline
                  className={`traffic-line ${series.className}`}
                  key={series.label}
                  points={polyline(series.values, width, height, chartPadding, maxTraffic)}
                />
              ))
            ) : (
              <text className="chart-empty" x={width / 2} y={height / 2}>
                {ui.waitingTelemetry}
              </text>
            )}
            </svg>
            {!hasTrafficSamples ? <p className="chart-empty-detail">{ui.trafficNoSamplesHint}</p> : null}
          </article>
        </section>

        <aside className="overview-side">
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
                            {node.protocol.toUpperCase()} :: {node.transport || "udp"}
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
                  <span>{item.nodes.length} nodes</span>
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
                  {node.protocol.toUpperCase()} :: {node.transport || "udp"}
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
  return (
    <div className="plugins-page page-enter">
      <div className="section-toolbar">
        <div className="segmented">
          <button className="active" type="button">
            {ui.pluginCenter}
          </button>
          <button type="button">
            {enabled}/{plugins.length} {ui.pluginEnabled}
          </button>
        </div>
        <div className="toolbar-actions">
          <button type="button">
            {installed}/{plugins.length} {ui.pluginInstalled}
          </button>
          <button type="button" onClick={onCheckUpdates}>{ui.checkUpdates}</button>
          <button className="primary-action" type="button" onClick={onInstallAll}>
            + {ui.add}
          </button>
        </div>
      </div>
      <div className="plugin-card-grid">
        {plugins.map((plugin) => {
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
  configPaths,
  configuredStatusLabel,
  copyDraft,
  currentLanguage,
  drafts,
  formatBytes: formatBytesFn,
  installBinary,
  launcherSettings,
  managedBinaries,
  managedStatusLabel,
  manualProfile,
  onAddManualProfile,
  onAddSuggestion,
  onCheckLatest,
  onDownloadLatest,
  onInstallWintun,
  onRefreshBinaries,
  onRemoveProfile,
  onSaveDrafts,
  onSaveRuntime,
  onScanSteam,
  onSectionChange,
  onStartRuntime,
  onStopRuntime,
  onUseManaged,
  onValidateConfigs,
  profiles,
  releaseChannelForKind: releaseChannelForKindFn,
  runtimeInputs,
  runtimePaths,
  runtimeRows,
  section,
  setBinarySourceInputs,
  setManualProfile,
  setReleaseChannelForKind: setReleaseChannelForKindFn,
  setRuntimeInputs,
  setSteamRoot,
  steamRoot,
  suggestions,
  ui,
  updateSteamLauncherSetting,
  validationResults,
}: {
  binaryBusy: boolean;
  binaryInfo: (kind: ManagedBinaryKind) => ManagedBinaryInfo | null;
  binaryReleases: Partial<Record<ManagedBinaryKind, RuntimeReleaseInfo>>;
  binarySourceInputs: Record<ManagedBinaryKind, string>;
  changeLanguage: (language: Language) => void;
  configPaths: ConfigDraftPaths | null;
  configuredStatusLabel: (binary: ManagedBinaryInfo) => string;
  copyDraft: (label: string, value: string) => Promise<void>;
  currentLanguage: Language;
  drafts: { core: string; error: string; xray: string };
  formatBytes: (value: number | null) => string;
  installBinary: (kind: ManagedBinaryKind) => Promise<void>;
  launcherSettings: LauncherSettings;
  managedBinaries: ManagedBinaryInventory | null;
  managedStatusLabel: (binary: ManagedBinaryInfo) => string;
  manualProfile: typeof emptyProfile;
  onAddManualProfile: () => void;
  onAddSuggestion: (profile: GameProfile) => void;
  onCheckLatest: (kind: ManagedBinaryKind) => void;
  onDownloadLatest: (kind: ManagedBinaryKind) => void;
  onInstallWintun: () => void;
  onRefreshBinaries: () => void;
  onRemoveProfile: (id: string) => void;
  onSaveDrafts: () => void;
  onSaveRuntime: () => void;
  onScanSteam: () => void;
  onSectionChange: (section: SettingsSection) => void;
  onStartRuntime: (kind: ManagedBinaryKind) => void;
  onStopRuntime: (kind: ManagedBinaryKind) => void;
  onUseManaged: (kind: ManagedBinaryKind) => void;
  onValidateConfigs: () => void;
  profiles: GameProfile[];
  releaseChannelForKind: (settings: RuntimeSettings, kind: ManagedBinaryKind) => ReleaseChannel;
  runtimeInputs: RuntimeSettings;
  runtimePaths: RuntimePaths | null;
  runtimeRows: Array<{ label: string; value: string }>;
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
  suggestions: GameProfile[];
  ui: typeof zh;
  updateSteamLauncherSetting: <K extends keyof LauncherSettings["steam"]>(
    key: K,
    value: LauncherSettings["steam"][K],
  ) => void;
  validationResults: ValidationResults;
}) {
  const sections: Array<{ id: SettingsSection; label: string }> = [
    { id: "general", label: ui.settingsGeneral },
    { id: "core", label: ui.coreSettings },
    { id: "rules", label: ui.rulesMode },
    { id: "plugins", label: ui.plugins },
    { id: "about", label: ui.settingsAbout },
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
                  <div><span>bin</span><strong>{runtimePaths.binDir}</strong></div>
                  <div><span>runtime-settings.json</span><strong>{runtimePaths.runtimeSettingsPath}</strong></div>
                </div>
              ) : null}
              <div className="runtime-list-mini">
                {runtimeRows.map((row) => (
                  <div key={row.label}><span>{row.label}</span><strong>{row.value}</strong></div>
                ))}
              </div>
              <div className="core-settings-grid">
                <label>
                  <span>{ui.tachyonServer}</span>
                  <input
                    placeholder="game.example.com:443"
                    value={runtimeInputs.tachyonServerAddress}
                    onChange={(event) =>
                      setRuntimeInputs((current) => ({ ...current, tachyonServerAddress: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{ui.tachyonTgpServer}</span>
                  <input
                    placeholder="optional, defaults to Tachyon server"
                    value={runtimeInputs.tachyonTgpServerAddress}
                    onChange={(event) =>
                      setRuntimeInputs((current) => ({ ...current, tachyonTgpServerAddress: event.target.value }))
                    }
                  />
                </label>
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
                  <label className="mini-check">
                    <input
                      checked={runtimeInputs.tachyonTunAutoRoute}
                      type="checkbox"
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({
                          ...current,
                          tachyonTunAutoRoute: event.target.checked,
                        }))
                      }
                    />
                    {ui.tachyonTunAutoRoute}
                  </label>
                </label>
                <label className="wide-field">
                  <span>{ui.tachyonTunDnsHijack}</span>
                  <label className="mini-check">
                    <input
                      checked={runtimeInputs.tachyonTunDnsHijack}
                      type="checkbox"
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({
                          ...current,
                          tachyonTunDnsHijack: event.target.checked,
                        }))
                      }
                    />
                    {ui.tachyonTunDnsHijack}
                  </label>
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
                        <span>{binary ? managedStatusLabel(binary) : "inventory unavailable"}</span>
                        {binary ? <span>{configuredStatusLabel(binary)}</span> : null}
                        {binary ? <span>{binary.targetPath}</span> : null}
                        {sidecars.map((dependency) => (
                          <span
                            className={dependency.exists ? "sidecar-status ok" : "sidecar-status missing"}
                            key={`${kind}-${dependency.name}`}
                          >
                            {dependency.name}: {dependency.exists ? "OK" : `Missing ${dependency.path}`}
                          </span>
                        ))}
                        {release ? (
                          <span>Latest {release.tagName}: {release.assetName} / {formatBytesFn(release.assetSizeBytes)}</span>
                        ) : null}
                      </div>
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
                          <option value="stable">Stable</option>
                          <option value="preview">Pre</option>
                        </select>
                      </label>
                      <div className="row-actions">
                        <button type="button" onClick={() => void installBinary(kind)}>{ui.install}</button>
                        <button type="button" onClick={() => onUseManaged(kind)}>{ui.useManaged}</button>
                        <button disabled={binaryBusy} type="button" onClick={() => onCheckLatest(kind)}>{ui.checkLatest}</button>
                        <button disabled={binaryBusy} type="button" onClick={() => onDownloadLatest(kind)}>{ui.installLatest}</button>
                        {kind === "tachyonCore" && missingWintun ? (
                          <button disabled={binaryBusy} type="button" onClick={onInstallWintun}>{ui.installWintun}</button>
                        ) : null}
                      </div>
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
              <ValidationSummary results={validationResults} />
              {configPaths ? (
                <div className="path-list">
                  <div><span>client.json</span><strong>{configPaths.coreConfigPath}</strong></div>
                  <div><span>xray-client.json</span><strong>{configPaths.xrayConfigPath}</strong></div>
                </div>
              ) : null}
              <div className="config-grid">
                <label><span>Xray</span><textarea data-config-draft="xray" readOnly value={drafts.xray} /></label>
                <label><span>Core</span><textarea data-config-draft="core" readOnly value={drafts.core} /></label>
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

function ValidationSummary({ results }: { results: ValidationResults }) {
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
            <strong>{result.ok ? "OK" : "Failed"}</strong>
            <small title={result.command}>{result.error || result.details}</small>
          </div>
        );
      })}
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
            <p>Selector :: {activeNode?.name ?? "--"}</p>
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
              <small>{node.protocol.toUpperCase()} :: {node.transport || "udp"}</small>
              {node.id === subscription.selectedNodeId ? <em>✓</em> : null}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
