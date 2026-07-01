export type Language = "en" | "zh-CN";

export type TranslationKey =
  | "action.add"
  | "action.addProgram"
  | "action.checkLatest"
  | "action.copyCore"
  | "action.copyXray"
  | "action.delete"
  | "action.import"
  | "action.install"
  | "action.installLatest"
  | "action.manage"
  | "action.refresh"
  | "action.remove"
  | "action.review"
  | "action.save"
  | "action.savePaths"
  | "action.scanSteam"
  | "action.select"
  | "action.selected"
  | "action.start"
  | "action.startAll"
  | "action.stop"
  | "action.stopAll"
  | "action.update"
  | "action.useManaged"
  | "app.subtitle"
  | "common.active"
  | "common.checking"
  | "common.connected"
  | "common.disconnected"
  | "common.enabled"
  | "common.nodes"
  | "common.ready"
  | "common.subscription"
  | "common.subscriptions"
  | "common.unavailable"
  | "field.displayName"
  | "field.executablePath"
  | "field.language"
  | "field.processName"
  | "field.releaseChannel"
  | "field.sourceBinaryPath"
  | "field.steamRoot"
  | "field.subscriptionName"
  | "field.subscriptionPayload"
  | "field.subscriptionUrl"
  | "nav.config"
  | "nav.game"
  | "nav.launchers"
  | "nav.nodes"
  | "nav.overview"
  | "nav.plugins"
  | "nav.runtime"
  | "nav.settings"
  | "panel.binaries"
  | "panel.config"
  | "panel.gameMode"
  | "panel.liveTelemetry"
  | "panel.plugins"
  | "panel.readiness"
  | "panel.runtime"
  | "panel.selectedNode"
  | "panel.status"
  | "panel.subscriptions"
  | "panel.trafficRules"
  | "plugin.rulePacks"
  | "plugin.rulePacksDesc"
  | "plugin.scripts"
  | "plugin.scriptsDesc"
  | "plugin.themes"
  | "plugin.themesDesc"
  | "settings.languageDesc"
  | "view.config.subtitle"
  | "view.config.title"
  | "view.game.subtitle"
  | "view.game.title"
  | "view.launchers.subtitle"
  | "view.launchers.title"
  | "view.nodes.subtitle"
  | "view.nodes.title"
  | "view.overview.subtitle"
  | "view.overview.title"
  | "view.plugins.subtitle"
  | "view.plugins.title"
  | "view.runtime.subtitle"
  | "view.runtime.title"
  | "view.settings.subtitle"
  | "view.settings.title";

const storageKey = "tachyon.prism.language.v1";

const dictionaries: Record<Language, Record<TranslationKey, string>> = {
  en: {
    "action.add": "Add",
    "action.addProgram": "Add Program",
    "action.checkLatest": "Check Latest",
    "action.copyCore": "Copy Core",
    "action.copyXray": "Copy Xray",
    "action.delete": "Delete",
    "action.import": "Import",
    "action.install": "Install",
    "action.installLatest": "Install Latest",
    "action.manage": "Manage",
    "action.refresh": "Refresh",
    "action.remove": "Remove",
    "action.review": "Review",
    "action.save": "Save",
    "action.savePaths": "Save Paths",
    "action.scanSteam": "Scan Steam",
    "action.select": "Select",
    "action.selected": "Selected",
    "action.start": "Start",
    "action.startAll": "Start All",
    "action.stop": "Stop",
    "action.stopAll": "Stop All",
    "action.update": "Update",
    "action.useManaged": "Use Managed",
    "app.subtitle": "Xray + Tachyon control plane",
    "common.active": "Active",
    "common.checking": "Checking",
    "common.connected": "Connected",
    "common.disconnected": "Disconnected",
    "common.enabled": "Enabled",
    "common.nodes": "Nodes",
    "common.ready": "Ready",
    "common.subscription": "Subscription",
    "common.subscriptions": "Subscriptions",
    "common.unavailable": "Unavailable",
    "field.displayName": "Display name",
    "field.executablePath": "Executable path",
    "field.language": "Language",
    "field.processName": "Process name",
    "field.releaseChannel": "Release channel",
    "field.sourceBinaryPath": "Source binary path",
    "field.steamRoot": "Steam root",
    "field.subscriptionName": "Subscription name",
    "field.subscriptionPayload": "Paste subscription payload",
    "field.subscriptionUrl": "Subscription URL",
    "nav.config": "Config",
    "nav.game": "Game Mode",
    "nav.launchers": "Launchers",
    "nav.nodes": "Subscriptions",
    "nav.overview": "Overview",
    "nav.plugins": "Plugins",
    "nav.runtime": "Runtime",
    "nav.settings": "Settings",
    "panel.binaries": "Binaries",
    "panel.config": "Config",
    "panel.gameMode": "Game Mode",
    "panel.liveTelemetry": "Live Telemetry",
    "panel.plugins": "Plugin Center",
    "panel.readiness": "Readiness",
    "panel.runtime": "Runtime",
    "panel.selectedNode": "Selected Node",
    "panel.status": "Status",
    "panel.subscriptions": "Subscriptions",
    "panel.trafficRules": "Traffic Rules",
    "plugin.rulePacks": "Rule Packs",
    "plugin.rulePacksDesc": "Share and import routing rule bundles.",
    "plugin.scripts": "Automation Scripts",
    "plugin.scriptsDesc": "Hook launch, update, and health events.",
    "plugin.themes": "Theme Gallery",
    "plugin.themesDesc": "Install compact, gaming, and accessibility themes.",
    "settings.languageDesc": "Choose the UI language. More languages can be added later without changing the app shell.",
    "view.config.subtitle": "Review and save generated JSON config files for both managed cores.",
    "view.config.title": "Config Drafts",
    "view.game.subtitle": "Manually add programs and tune the UDP game acceleration policy.",
    "view.game.title": "Game Mode",
    "view.launchers.subtitle": "Scan Steam libraries and map launched games into acceleration profiles.",
    "view.launchers.title": "Launchers",
    "view.nodes.subtitle": "Manage named subscriptions, inspect parsed Xray nodes, and choose the active route.",
    "view.nodes.title": "Subscription Center",
    "view.overview.subtitle": "Runtime health, selected egress, game acceleration and profile state.",
    "view.overview.title": "Overview",
    "view.plugins.subtitle": "Extension surface for rule packs, scripts, and visual themes.",
    "view.plugins.title": "Plugin Center",
    "view.runtime.subtitle": "Manage external Xray Core and Tachyon Core binaries, releases and subprocesses.",
    "view.runtime.title": "Runtime",
    "view.settings.subtitle": "Language, behavior and interface preferences.",
    "view.settings.title": "Settings",
  },
  "zh-CN": {
    "action.add": "添加",
    "action.addProgram": "添加程序",
    "action.checkLatest": "检查最新版",
    "action.copyCore": "复制 Core",
    "action.copyXray": "复制 Xray",
    "action.delete": "删除",
    "action.import": "导入",
    "action.install": "安装",
    "action.installLatest": "安装最新版",
    "action.manage": "管理",
    "action.refresh": "刷新",
    "action.remove": "移除",
    "action.review": "检查",
    "action.save": "保存",
    "action.savePaths": "保存路径",
    "action.scanSteam": "扫描 Steam",
    "action.select": "选择",
    "action.selected": "已选择",
    "action.start": "启动",
    "action.startAll": "全部启动",
    "action.stop": "停止",
    "action.stopAll": "全部停止",
    "action.update": "更新",
    "action.useManaged": "使用托管",
    "app.subtitle": "Xray + Tachyon 控制面",
    "common.active": "启用",
    "common.checking": "检查中",
    "common.connected": "已连接",
    "common.disconnected": "未连接",
    "common.enabled": "已启用",
    "common.nodes": "节点",
    "common.ready": "就绪",
    "common.subscription": "订阅",
    "common.subscriptions": "订阅",
    "common.unavailable": "不可用",
    "field.displayName": "显示名称",
    "field.executablePath": "可执行文件路径",
    "field.language": "语言",
    "field.processName": "进程名",
    "field.releaseChannel": "发布通道",
    "field.sourceBinaryPath": "源二进制路径",
    "field.steamRoot": "Steam 根目录",
    "field.subscriptionName": "订阅名称",
    "field.subscriptionPayload": "粘贴订阅内容",
    "field.subscriptionUrl": "订阅地址",
    "nav.config": "配置",
    "nav.game": "游戏模式",
    "nav.launchers": "启动器",
    "nav.nodes": "订阅",
    "nav.overview": "概览",
    "nav.plugins": "插件",
    "nav.runtime": "核心",
    "nav.settings": "设置",
    "panel.binaries": "核心二进制",
    "panel.config": "配置",
    "panel.gameMode": "游戏模式",
    "panel.liveTelemetry": "实时遥测",
    "panel.plugins": "插件中心",
    "panel.readiness": "就绪检查",
    "panel.runtime": "运行时",
    "panel.selectedNode": "当前节点",
    "panel.status": "状态",
    "panel.subscriptions": "订阅管理",
    "panel.trafficRules": "流量规则",
    "plugin.rulePacks": "规则包",
    "plugin.rulePacksDesc": "分享和导入路由规则集合。",
    "plugin.scripts": "自动化脚本",
    "plugin.scriptsDesc": "挂接启动、更新和健康检查事件。",
    "plugin.themes": "主题库",
    "plugin.themesDesc": "安装紧凑、游戏和无障碍主题。",
    "settings.languageDesc": "选择界面语言。后续可以继续扩展更多语言而不改动应用外壳。",
    "view.config.subtitle": "检查并保存两个核心的 JSON 配置草稿。",
    "view.config.title": "配置草稿",
    "view.game.subtitle": "手动添加程序并调整 UDP 游戏加速策略。",
    "view.game.title": "游戏模式",
    "view.launchers.subtitle": "扫描 Steam 游戏库，把启动的游戏映射为加速配置。",
    "view.launchers.title": "启动器",
    "view.nodes.subtitle": "管理命名订阅，查看解析出的 Xray 节点，并选择当前线路。",
    "view.nodes.title": "订阅中心",
    "view.overview.subtitle": "运行状态、当前出口、游戏加速和配置概览。",
    "view.overview.title": "概览",
    "view.plugins.subtitle": "为规则包、脚本和界面主题预留的扩展中心。",
    "view.plugins.title": "插件中心",
    "view.runtime.subtitle": "管理外部 Xray Core 与 Tachyon Core 二进制、发布通道和进程。",
    "view.runtime.title": "核心运行时",
    "view.settings.subtitle": "语言、行为和界面偏好。",
    "view.settings.title": "设置",
  },
};

export function loadLanguage(): Language {
  const stored = globalThis.localStorage?.getItem(storageKey);
  return stored === "zh-CN" || stored === "en" ? stored : "zh-CN";
}

export function saveLanguage(language: Language): void {
  globalThis.localStorage?.setItem(storageKey, language);
}

export function createTranslator(language: Language): (key: TranslationKey) => string {
  return (key) => dictionaries[language][key] ?? dictionaries.en[key] ?? key;
}
