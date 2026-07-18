import type { Language } from "./i18n";
import type { TachyonCorePreflightMessages } from "./runtime";

const english: TachyonCorePreflightMessages = {
  capabilityUnavailable: "required capability is unavailable",
  checkConfirmed: "{label}: confirmed",
  checkLabels: {
    AUTO_ROUTE_DISABLED: "Automatic routing disabled",
    AUTO_ROUTE_SEMANTICS: "Automatic routing disabled",
    CLIENT_REQUIRES_TUN: "Client TUN requirement",
    CONFIG_VALID: "Core configuration",
    IFCONFIG_PRESENT: "ifconfig tool",
    ROUTE_PRESENT: "route tool",
    SELECTIVE_ROUTES_SUPPORTED: "Selective game routes",
    TUN_DEVICE_PRESENT: "TUN device",
    TUN_PRIVILEGE: "TUN privilege",
    TUN_REQUIRED: "Client TUN requirement",
    WINTUN_DLL_PRESENT: "Wintun sidecar",
  },
  checkNotReady: "{label}: not ready",
  checkSkipped: "{label}: skipped",
  checkWarning: "{label}: requires attention",
  diagnosticDetails: "Diagnostic details: {details}",
  fallback: "Core version lacks preflight; validate only",
  issues: "Tachyon Core preflight found readiness issues: {details}",
  passed: "Tachyon Core preflight passed",
  startBlocked: "Tachyon Core game acceleration cannot start: {details}.",
  unknownCheck: "Core check {code}",
  warnings: "Tachyon Core preflight completed with warnings: {details}",
  xrayIndependent: "Xray local proxy can still run independently.",
};

const simplifiedChinese: TachyonCorePreflightMessages = {
  capabilityUnavailable: "所需能力不可用",
  checkConfirmed: "{label}：已确认",
  checkLabels: {
    AUTO_ROUTE_DISABLED: "自动路由关闭状态",
    AUTO_ROUTE_SEMANTICS: "自动路由关闭状态",
    CLIENT_REQUIRES_TUN: "客户端 TUN 要求",
    CONFIG_VALID: "Core 配置",
    IFCONFIG_PRESENT: "ifconfig 工具",
    ROUTE_PRESENT: "route 工具",
    SELECTIVE_ROUTES_SUPPORTED: "选择性游戏路由",
    TUN_DEVICE_PRESENT: "TUN 设备",
    TUN_PRIVILEGE: "TUN 权限",
    TUN_REQUIRED: "客户端 TUN 要求",
    WINTUN_DLL_PRESENT: "Wintun 配套文件",
  },
  checkNotReady: "{label}：未就绪",
  checkSkipped: "{label}：已跳过",
  checkWarning: "{label}：需要检查",
  diagnosticDetails: "诊断详情：{details}",
  fallback: "Core 版本不支持启动前检查；仅验证配置",
  issues: "Tachyon Core 启动前检查发现就绪问题：{details}",
  passed: "Tachyon Core 启动前检查通过",
  startBlocked: "Tachyon Core 游戏加速无法启动：{details}。",
  unknownCheck: "Core 检查 {code}",
  warnings: "Tachyon Core 启动前检查完成，但存在警告：{details}",
  xrayIndependent: "Xray 本地代理仍可独立运行。",
};

export function preflightMessagesForLanguage(
  language: Language,
): TachyonCorePreflightMessages {
  return language === "zh-CN" ? simplifiedChinese : english;
}
