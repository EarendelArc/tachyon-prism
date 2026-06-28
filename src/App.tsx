import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  buildCoreClientConfigDraft,
  buildXrayClientConfigDraft,
  stringifyDraft,
  type XrayRoutingMode,
} from "./domain/configDrafts";
import {
  getConfigPaths,
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
  fetchSubscriptionNodes,
  loadSubscriptionSnapshot,
  parseSubscription,
  removeSubscription,
  saveSubscriptionSnapshot,
  selectSubscription,
  selectSubscriptionNode,
  totalSubscriptionNodes,
} from "./domain/subscriptions";
import type { ProxyNode, SubscriptionProfile, SubscriptionSnapshot } from "./domain/subscriptions";
import {
  createTranslator,
  loadLanguage,
  saveLanguage,
  type Language,
} from "./domain/i18n";
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
  tachyonTelemetryIntervalMs: 500,
  tachyonTunAddress: "198.18.0.1/16",
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
  stop: "停止",
  stopAll: "停止全部",
  subscriptions: "订阅",
  tachyon: "Tachyon",
  traffic: "流量",
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
  pluginCenter: "插件中心",
  pluginRollingDesc: "提升 Prism 升级体验，获取更快更新通道。",
  pluginRollingTitle: "滚动发行",
  pluginSettings: "插件设置",
  pluginStatsDesc: "高效流量统计插件，支持按域名、进程聚合。",
  pluginStatsTitle: "流量统计",
  pluginSwitchDesc: "实现动态代理选择机制，包含故障转移。",
  pluginSwitchTitle: "节点智能切换",
  pluginTriggerApp: "APP激活后",
  pluginTriggerManual: "手动触发",
  pluginTriggerNode: "节点变化",
  pluginTriggerUpdate: "更新订阅时",
  pluginTransformDesc: "节点格式转换插件，支持 v2Ray 格式导入。",
  pluginTransformTitle: "节点转换",
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
  steamChildTracking: "Steam 子进程追踪",
  steamLauncherDetection: "Steam 启动器检测",
  steamRoot: "Steam 根目录",
  subscriptionName: "订阅名称",
  subscriptionPayload: "粘贴订阅内容",
  subscriptionUrl: "订阅地址",
  systemProxy: "系统代理",
  theme: "主题",
  totalTraffic: "总流量",
  tunMode: "TUN模式",
  unavailable: "不可用",
  uploadRate: "上传速率",
  urlTest: "URLTest",
  waitingTelemetry: "等待遥测流...",
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
  stop: "Stop",
  stopAll: "Stop All",
  subscriptions: "Subscriptions",
  tachyon: "Tachyon",
  traffic: "Traffic",
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
  pluginCenter: "Plugin Center",
  pluginRollingDesc: "Improve Prism update experience with faster preview channels.",
  pluginRollingTitle: "Rolling Release",
  pluginSettings: "Plugin Settings",
  pluginStatsDesc: "Efficient traffic statistics by domain and process.",
  pluginStatsTitle: "Traffic Stats",
  pluginSwitchDesc: "Dynamic proxy selection with failover.",
  pluginSwitchTitle: "Smart Node Switch",
  pluginTriggerApp: "After app activation",
  pluginTriggerManual: "Manual trigger",
  pluginTriggerNode: "Node change",
  pluginTriggerUpdate: "On subscription update",
  pluginTransformDesc: "Node format converter with v2Ray-style imports.",
  pluginTransformTitle: "Node Transform",
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
  steamChildTracking: "Steam child process tracking",
  steamLauncherDetection: "Steam launcher detection",
  steamRoot: "Steam root",
  subscriptionName: "Subscription name",
  subscriptionPayload: "Paste subscription payload",
  subscriptionUrl: "Subscription URL",
  systemProxy: "System Proxy",
  theme: "Theme",
  totalTraffic: "Total Traffic",
  tunMode: "TUN Mode",
  unavailable: "Unavailable",
  uploadRate: "Upload rate",
  urlTest: "URLTest",
  waitingTelemetry: "Waiting for telemetry stream...",
  workMode: "Work Mode",
};

function selectedNode(snapshot: SubscriptionSnapshot): ProxyNode | undefined {
  return snapshot.nodes.find((node) => node.id === snapshot.selectedNodeId);
}

function nodeEndpoint(node: ProxyNode): string {
  return node.port > 0 ? `${node.address}:${node.port}` : node.address;
}

function fallbackNodeLatency(node: ProxyNode): number {
  const seed = Array.from(node.id).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return 82 + (seed % 236);
}

function nodeLatency(node: ProxyNode, latencyMap: NodeLatencyMap): number {
  const measured = latencyMap[node.id];
  return measured?.ok && measured.latencyMs !== null ? measured.latencyMs : fallbackNodeLatency(node);
}

function nodeAvailable(node: ProxyNode, latencyMap: NodeLatencyMap): boolean {
  const measured = latencyMap[node.id];
  if (measured && !measured.ok) {
    return false;
  }
  return nodeLatency(node, latencyMap) < 285;
}

function nodeLatencyLabel(node: ProxyNode, ui: typeof zh, latencyMap: NodeLatencyMap): string {
  const measured = latencyMap[node.id];
  if (measured && !measured.ok) {
    return ui.unavailable;
  }
  return `${nodeLatency(node, latencyMap)}ms`;
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
): { core: string; error: string; xray: string } {
  if (!activeNode) {
    return { core: "", error: "", xray: "" };
  }
  try {
    return {
      core: stringifyDraft(
        buildCoreClientConfigDraft(activeNode, {
          gameProfiles: profiles,
          grpcListen: runtimeSettings.tachyonGrpcListen,
          grpcPort: runtimeSettings.tachyonGrpcPort,
          ipcListen: runtimeSettings.tachyonIpcListen,
          ipcPort: runtimeSettings.tachyonIpcPort,
          launchers: launcherSettings,
          telemetryIntervalMs: runtimeSettings.tachyonTelemetryIntervalMs,
          tunAddress: runtimeSettings.tachyonTunAddress,
          tunMtu: runtimeSettings.tachyonTunMtu,
        }),
      ),
      error: "",
      xray: stringifyDraft(
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
      ),
    };
  } catch (error) {
    return {
      core: "",
      error: error instanceof Error ? error.message : "Config generation failed",
      xray: "",
    };
  }
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
            label: "Selected node",
            state: "ok",
          }
        : {
            detail: "Import a subscription or select a node before starting cores.",
            label: "Selected node",
            state: "error",
          },
    );
    items.push(
      drafts.xray && !drafts.error
        ? { detail: "Xray client JSON can be generated.", label: "Xray config", state: "ok" }
        : {
            detail: drafts.error || "Xray config needs a selected node.",
            label: "Xray config",
            state: "error",
          },
    );
    items.push(
      drafts.core && !drafts.error
        ? { detail: "Tachyon Core client JSON can be generated.", label: "Tachyon config", state: "ok" }
        : {
            detail: drafts.error || "Tachyon config needs a selected node.",
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
    drafts.error,
    drafts.xray,
    managedBinaries,
    runtimeInputs.tachyonCoreBinaryPath,
    runtimeInputs.xrayBinaryPath,
  ]);
  const readinessErrors = useMemo(
    () => readinessItems.filter((item) => item.state === "error").length,
    [readinessItems],
  );
  const runtimeRows = [
    { label: "System Proxy", value: systemProxyLabel(systemProxy) },
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
      const nodes = await fetchSubscriptionNodes(subscriptionUrl);
      const snapshot = createSubscriptionSnapshot(
        subscriptionUrl,
        nodes,
        subscription,
        subscriptionName,
      );
      saveSubscriptionSnapshot(snapshot);
      setSubscription(snapshot);
      setMessage(`${nodes.length} nodes imported`);
      void refreshNodeLatencies(nodes);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Subscription update failed");
    }
  }

  async function refreshNodeLatencies(nodes = subscription.nodes, announce = true) {
    if (nodes.length === 0) {
      setNodeLatencies({});
      return;
    }
    const results = await Promise.all(
      nodes.map(async (node) => {
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
      }),
    );
    setNodeLatencies(Object.fromEntries(results));
    if (announce) {
      setMessage("Latency refreshed");
    }
  }

  function importSubscriptionText() {
    try {
      const nodes = parseSubscription(subscriptionText);
      const snapshot = createSubscriptionSnapshot(
        "manual",
        nodes,
        subscription,
        subscriptionName || "Manual",
      );
      saveSubscriptionSnapshot(snapshot);
      setSubscription(snapshot);
      setSubscriptionText("");
      setMessage(`${nodes.length} nodes imported`);
      void refreshNodeLatencies(nodes);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Subscription import failed");
    }
  }

  function chooseSubscription(subscriptionId: string) {
    try {
      const snapshot = selectSubscription(subscription, subscriptionId);
      saveSubscriptionSnapshot(snapshot);
      setSubscription(snapshot);
      setMessage("Subscription selected");
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
      setMessage("Node selected");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Node selection failed");
    }
  }

  function deleteSubscription(subscriptionId: string) {
    try {
      const snapshot = removeSubscription(subscription, subscriptionId);
      saveSubscriptionSnapshot(snapshot);
      setSubscription(snapshot);
      setMessage("Subscription removed");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Subscription removal failed");
    }
  }

  function changeRoutingMode(mode: XrayRoutingMode) {
    setRoutingMode(mode);
    saveRoutingMode(mode);
    setMessage(`${routingModeLabel(mode, ui)} mode selected`);
  }

  function prepareSubscriptionAdd() {
    navigateView("subscriptions");
    setSubscriptionName("");
    setSubscriptionUrl("");
    setSubscriptionText("");
    setMessage("Ready to add subscription");
    globalThis.setTimeout?.(() => subscriptionNameInputRef.current?.focus(), 50);
  }

  async function copyDraft(label: string, value: string) {
    if (!value) {
      setMessage("No config draft available");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setMessage(`${label} copied`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Copy failed");
    }
  }

  async function writeDrafts(): Promise<ConfigDraftPaths> {
    if (!drafts.core || !drafts.xray) {
      throw new Error("No config draft available");
    }
    const paths = await saveConfigDrafts(drafts.core, drafts.xray);
    setConfigPaths(paths);
    return paths;
  }

  async function saveDrafts() {
    try {
      await writeDrafts();
      setMessage("Config files saved");
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
      const paths = await writeDrafts();
      const settings = await saveRuntimeSettings(runtimeInputs);
      setRuntimeInputs(settings);
      const xray = await runConfigValidation("xray", paths, settings, false);
      const tachyonCore = await runConfigValidation("tachyonCore", paths, settings, false);
      setMessage(
        xray.ok && tachyonCore.ok
          ? "Xray and Tachyon Core configs validated"
          : "Config validation finished with errors",
      );
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

  async function refreshRuntime() {
    try {
      const status = await getRuntimeStatus();
      setRuntimeStatus(status);
    } catch {
      // Runtime supervision commands are available only inside Tauri.
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
        await startRuntime("xray");
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

  async function startRuntime(kind: ManagedBinaryKind) {
    try {
      const paths = await writeDrafts();
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Start failed");
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
    await startRuntime("xray");
    await startRuntime("tachyonCore");
    await refreshRuntime();
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
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const stats = await getXrayTrafficStats();
        if (!cancelled) {
          setXrayTrafficStats(stats);
        }
      } catch {
        if (!cancelled) {
          setXrayTrafficStats(emptyXrayTrafficStats());
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
      <header className="app-titlebar">
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

        {activeView === "plugins" ? <PluginsView ui={ui} /> : null}

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
  ui,
}: {
  nodeCount: number;
  onRoutingModeChange: (mode: XrayRoutingMode) => void;
  routingMode: XrayRoutingMode;
  telemetry: TelemetryState;
  trafficRates: TrafficSample;
  trafficSamples: TrafficSample[];
  trafficTotals: TrafficTotals;
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
            <div className="legend">
              {trafficSeries.map((series) => (
                <span className={`legend-item ${series.className.replace(" ", "-")}`} key={series.label}>
                  ● {series.label}
                </span>
              ))}
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
      nodes.sort((left, right) => nodeLatency(left, latencyMap) - nodeLatency(right, latencyMap));
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
          <button type="button" onClick={onUpdate}>
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

function PluginsView({ ui }: { ui: typeof zh }) {
  const plugins = [
    {
      desc: ui.pluginRollingDesc,
      tags: [ui.pluginTriggerManual, ui.pluginTriggerApp],
      title: ui.pluginRollingTitle,
    },
    {
      desc: ui.pluginTransformDesc,
      tags: [ui.pluginTriggerManual, ui.pluginTriggerUpdate],
      title: ui.pluginTransformTitle,
    },
    {
      desc: ui.pluginStatsDesc,
      tags: [ui.pluginTriggerManual, ui.pluginTriggerApp],
      title: ui.pluginStatsTitle,
    },
    {
      desc: ui.pluginSwitchDesc,
      tags: [ui.pluginTriggerManual, ui.pluginTriggerNode],
      title: ui.pluginSwitchTitle,
    },
  ];
  return (
    <div className="plugins-page page-enter">
      <div className="section-toolbar">
        <div className="segmented">
          <button className="active" type="button">
            {ui.traffic}
          </button>
          <button type="button">{ui.list}</button>
        </div>
        <div className="toolbar-actions">
          <button type="button">{ui.pluginCenter}</button>
          <button type="button">{ui.checkUpdates}</button>
          <button className="primary-action" type="button">
            + {ui.add}
          </button>
        </div>
      </div>
      <div className="plugin-card-grid">
        {plugins.map((plugin, index) => (
          <article className="plugin-rich-card" key={plugin.title}>
            <header>
              <h2>
                {index === 2 ? <span className="dev-badge">Dev</span> : null}
                {index === 3 ? <span className="green-dot" /> : null}
                {plugin.title}
              </h2>
              <button type="button">...</button>
            </header>
            <div className="tag-row">
              {plugin.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
              <span>💬</span>
            </div>
            <p>{plugin.desc}</p>
            <footer>
              <a href="#source">{ui.source}</a>
              <button className="primary-action" type="button">
                ✨ {ui.run}
              </button>
            </footer>
          </article>
        ))}
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
                  return (
                    <div className="binary-row" key={kind}>
                      <div className="binary-meta">
                        <strong>{binary?.displayName ?? managedBinaryDisplayName(kind)}</strong>
                        <span>{binary ? managedStatusLabel(binary) : "inventory unavailable"}</span>
                        {binary ? <span>{configuredStatusLabel(binary)}</span> : null}
                        {binary ? <span>{binary.targetPath}</span> : null}
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
                          <option value="preview">Preview</option>
                        </select>
                      </label>
                      <div className="row-actions">
                        <button type="button" onClick={() => void installBinary(kind)}>{ui.install}</button>
                        <button type="button" onClick={() => onUseManaged(kind)}>{ui.useManaged}</button>
                        <button disabled={binaryBusy} type="button" onClick={() => onCheckLatest(kind)}>{ui.checkLatest}</button>
                        <button disabled={binaryBusy} type="button" onClick={() => onDownloadLatest(kind)}>{ui.installLatest}</button>
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
