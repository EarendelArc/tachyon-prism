import { useEffect, useMemo, useState } from "react";
import {
  buildCoreClientConfigDraft,
  buildXrayClientConfigDraft,
  stringifyDraft,
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
  getManagedBinaries,
  getLatestTachyonCoreRelease,
  getLatestXrayRelease,
  getRuntimePaths,
  getRuntimeSettings,
  getRuntimeStatus,
  installLatestTachyonCore,
  installLatestXray,
  installManagedBinary,
  saveRuntimeSettings,
  startTachyonCore,
  startXray,
  stopTachyonCore,
  stopXray,
  type ManagedBinaryInfo,
  type ManagedBinaryInventory,
  type ManagedBinaryKind,
  type ProcessStatus,
  type RuntimePaths,
  type RuntimeReleaseInfo,
  type RuntimeStatus,
} from "./domain/runtime";
import {
  createSubscriptionSnapshot,
  fetchSubscriptionNodes,
  loadSubscriptionSnapshot,
  parseSubscription,
  saveSubscriptionSnapshot,
  selectSubscriptionNode,
} from "./domain/subscriptions";
import type { ProxyNode, SubscriptionSnapshot } from "./domain/subscriptions";
import { TelemetryClient } from "./domain/telemetry";
import type { TelemetryState, TelemetryData, RouteEventData } from "./domain/telemetry";

type ConnectionState = "checking" | "connected" | "disconnected";
type PrismView = "overview" | "nodes" | "game" | "launchers" | "runtime" | "config";
type ReadinessState = "error" | "ok" | "warning";

interface ReadinessItem {
  detail: string;
  label: string;
  state: ReadinessState;
}

const emptyProfile = {
  displayName: "",
  processName: "",
  executablePath: "",
};

const emptyRuntimeInputs = {
  tachyonCoreBinaryPath: "",
  xrayBinaryPath: "",
};

const emptyBinarySourceInputs = {
  tachyonCore: "",
  xray: "",
};

const managedBinaryKinds: ManagedBinaryKind[] = ["xray", "tachyonCore"];

function selectedNode(snapshot: SubscriptionSnapshot): ProxyNode | undefined {
  return snapshot.nodes.find((node) => node.id === snapshot.selectedNodeId);
}

function nodeEndpoint(node: ProxyNode): string {
  return node.port > 0 ? `${node.address}:${node.port}` : node.address;
}

function processStatusLabel(status: ProcessStatus | undefined): string {
  if (!status) {
    return "unknown";
  }
  return status.pid ? `${status.state} pid ${status.pid}` : status.state;
}

function formatBytes(value: number | null): string {
  if (value === null) {
    return "unknown size";
  }
  if (value < 1024 * 1024) {
    return `${Math.max(1, Math.round(value / 1024))} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function managedStatusLabel(binary: ManagedBinaryInfo): string {
  return binary.managedExists
    ? `installed, ${formatBytes(binary.managedSizeBytes)}`
    : "not installed";
}

function configuredStatusLabel(binary: ManagedBinaryInfo): string {
  return binary.configuredExists ? "configured path exists" : "configured path missing";
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
    return {
      detail: path,
      label,
      state: "warning",
    };
  }
  if (binary.configuredPath === path && !binary.configuredExists) {
    return {
      detail: `Configured executable is missing: ${path}`,
      label,
      state: "error",
    };
  }
  return {
    detail: path,
    label,
    state: "ok",
  };
}

function sidecarReadiness(binary: ManagedBinaryInfo | undefined): ReadinessItem[] {
  if (!binary) {
    return [];
  }
  return binary.sidecarDependencies
    .filter((dependency) => dependency.required)
    .map((dependency) => ({
      detail: dependency.exists
        ? dependency.path
        : `Missing required sidecar: ${dependency.path}`,
      label: dependency.name,
      state: dependency.exists ? "ok" : "error",
    }));
}

function draftText(
  activeNode: ProxyNode | undefined,
  profiles: GameProfile[],
  launcherSettings: LauncherSettings,
): {
  core: string;
  error: string;
  xray: string;
} {
  if (!activeNode) {
    return { core: "", error: "", xray: "" };
  }

  try {
    return {
      core: stringifyDraft(
        buildCoreClientConfigDraft(activeNode, {
          gameProfiles: profiles,
          launchers: launcherSettings,
        }),
      ),
      error: "",
      xray: stringifyDraft(buildXrayClientConfigDraft(activeNode)),
    };
  } catch (error) {
    return {
      core: "",
      error: error instanceof Error ? error.message : "Config generation failed",
      xray: "",
    };
  }
}

function TelemetryMetrics({ data }: { data: TelemetryData }) {
  return (
    <div className="runtime-status-list">
      <div>
        <span>Packets</span>
        <strong>{data.packets_read.toLocaleString()}</strong>
      </div>
      <div>
        <span>TGP</span>
        <strong>{data.decided_tgp.toLocaleString()}</strong>
      </div>
      <div>
        <span>Direct</span>
        <strong>{data.decided_direct.toLocaleString()}</strong>
      </div>
      <div>
        <span>Drop</span>
        <strong>{data.decided_drop.toLocaleString()}</strong>
      </div>
      <div>
        <span>Sessions</span>
        <strong>{data.tgp_sessions}</strong>
      </div>
      <div>
        <span>Goroutines</span>
        <strong>{data.goroutines}</strong>
      </div>
    </div>
  );
}

export function App() {
  const [activeView, setActiveView] = useState<PrismView>("overview");
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [profiles, setProfiles] = useState<GameProfile[]>(defaultGameProfiles);
  const [launcherSettings, setLauncherSettings] = useState(loadLauncherSettings);
  const [suggestions, setSuggestions] = useState<GameProfile[]>([]);
  const [steamRoot, setSteamRoot] = useState("");
  const [manualProfile, setManualProfile] = useState(emptyProfile);
  const [subscription, setSubscription] = useState(loadSubscriptionSnapshot);
  const [subscriptionUrl, setSubscriptionUrl] = useState("");
  const [subscriptionText, setSubscriptionText] = useState("");
  const [configPaths, setConfigPaths] = useState<ConfigDraftPaths | null>(null);
  const [runtimePaths, setRuntimePaths] = useState<RuntimePaths | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [runtimeInputs, setRuntimeInputs] = useState(emptyRuntimeInputs);
  const [managedBinaries, setManagedBinaries] = useState<ManagedBinaryInventory | null>(null);
  const [binarySourceInputs, setBinarySourceInputs] = useState(emptyBinarySourceInputs);
  const [binaryReleases, setBinaryReleases] = useState<
    Partial<Record<ManagedBinaryKind, RuntimeReleaseInfo>>
  >({});
  const [binaryBusy, setBinaryBusy] = useState(false);
  const [message, setMessage] = useState("Ready");
  const [telemetry, setTelemetry] = useState<TelemetryState>(() => ({
    connection: "disconnected" as const,
    hello: null,
    latestTelemetry: null,
    recentRoutes: [],
    recentErrors: [],
  }));
  const telemetryClient = useMemo(() => new TelemetryClient(), []);

  const activeProfiles = useMemo(
    () => profiles.filter((profile) => profile.enabled).length,
    [profiles],
  );
  const activeNode = useMemo(() => selectedNode(subscription), [subscription]);
  const drafts = useMemo(
    () => draftText(activeNode, profiles, launcherSettings),
    [activeNode, launcherSettings, profiles],
  );
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
        ? {
            detail: "Tachyon Core client JSON can be generated.",
            label: "Tachyon config",
            state: "ok",
          }
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

    const id = `manual-${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
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
      udpPolicy: "tgp",
      tcpPolicy: "auto",
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
      await saveGameProfile({
        ...profile,
        manual: true,
        priority: 80,
      });
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
      steam: {
        ...launcherSettings.steam,
        [key]: value,
      },
    };
    saveLauncherSettings(nextSettings);
    setLauncherSettings(nextSettings);
    setMessage("Launcher settings saved");
  }

  async function updateSubscriptionFromUrl() {
    try {
      const nodes = await fetchSubscriptionNodes(subscriptionUrl);
      const snapshot = createSubscriptionSnapshot(subscriptionUrl, nodes, subscription);
      saveSubscriptionSnapshot(snapshot);
      setSubscription(snapshot);
      setMessage(`${nodes.length} nodes imported`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Subscription update failed");
    }
  }

  function importSubscriptionText() {
    try {
      const nodes = parseSubscription(subscriptionText);
      const snapshot = createSubscriptionSnapshot("manual", nodes, subscription);
      saveSubscriptionSnapshot(snapshot);
      setSubscription(snapshot);
      setSubscriptionText("");
      setMessage(`${nodes.length} nodes imported`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Subscription import failed");
    }
  }

  function chooseNode(nodeId: string) {
    try {
      const snapshot = selectSubscriptionNode(subscription, nodeId);
      saveSubscriptionSnapshot(snapshot);
      setSubscription(snapshot);
      setMessage("Node selected");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Node selection failed");
    }
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
      const release =
        kind === "xray" ? await getLatestXrayRelease() : await getLatestTachyonCoreRelease();
      setBinaryReleases((current) => ({
        ...current,
        [kind]: release,
      }));
      setMessage(`Latest ${managedBinaryDisplayName(kind)} ${release.tagName}`);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : `${managedBinaryDisplayName(kind)} release check failed`,
      );
    } finally {
      setBinaryBusy(false);
    }
  }

  async function downloadLatestRelease(kind: ManagedBinaryKind) {
    try {
      setBinaryBusy(true);
      const result =
        kind === "xray" ? await installLatestXray() : await installLatestTachyonCore();
      setBinaryReleases((current) => ({
        ...current,
        [kind]: result.release,
      }));
      setManagedBinaries(result.inventory);
      setRuntimeInputs(result.inventory.runtimeSettings);
      setMessage(`${managedBinaryDisplayName(kind)} ${result.release.tagName} installed`);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : `${managedBinaryDisplayName(kind)} install failed`,
      );
    } finally {
      setBinaryBusy(false);
    }
  }

  async function refreshRuntime() {
    try {
      setRuntimeStatus(await getRuntimeStatus());
    } catch {
      // Runtime commands are available only inside Tauri.
    }
  }

  function binaryPreflightError(kind: ManagedBinaryKind): string | null {
    const path =
      kind === "xray"
        ? runtimeInputs.xrayBinaryPath.trim()
        : runtimeInputs.tachyonCoreBinaryPath.trim();
    if (!path) {
      return `${managedBinaryDisplayName(kind)} binary path required`;
    }
    const binary = binaryInfo(kind);
    if (binary && binary.configuredPath === path && !binary.configuredExists) {
      return `${managedBinaryDisplayName(kind)} binary not found: ${path}`;
    }
    if (binary && kind === "tachyonCore" && binary.configuredPath === path) {
      const missingSidecar = binary.sidecarDependencies.find(
        (dependency) => dependency.required && !dependency.exists,
      );
      if (missingSidecar) {
        return `${missingSidecar.name} required next to Tachyon Core: ${missingSidecar.path}`;
      }
    }
    return null;
  }

  function runtimePreflightErrors(kind?: ManagedBinaryKind): string[] {
    const errors: string[] = [];
    if (!activeNode) {
      errors.push("Select a node first");
    }
    if (drafts.error) {
      errors.push(drafts.error);
    }
    if ((!kind || kind === "xray") && !drafts.xray) {
      errors.push("Xray config draft unavailable");
    }
    if ((!kind || kind === "tachyonCore") && !drafts.core) {
      errors.push("Tachyon config draft unavailable");
    }
    if (!kind || kind === "xray") {
      const error = binaryPreflightError("xray");
      if (error) {
        errors.push(error);
      }
    }
    if (!kind || kind === "tachyonCore") {
      const error = binaryPreflightError("tachyonCore");
      if (error) {
        errors.push(error);
      }
    }
    return Array.from(new Set(errors));
  }

  async function startRuntime(kind: "tachyonCore" | "xray") {
    try {
      const errors = runtimePreflightErrors(kind);
      if (errors.length > 0) {
        setMessage(errors[0]);
        return;
      }
      const paths = await writeDrafts();
      const settings = await saveRuntimeSettings(runtimeInputs);
      setRuntimeInputs(settings);
      if (kind === "xray") {
        const binaryPath = settings.xrayBinaryPath.trim();
        if (!binaryPath) {
          setMessage("Xray binary path required");
          return;
        }
        await startXray(binaryPath, paths.xrayConfigPath);
        setMessage("Xray started");
      } else {
        const binaryPath = settings.tachyonCoreBinaryPath.trim();
        if (!binaryPath) {
          setMessage("Core binary path required");
          return;
        }
        await startTachyonCore(binaryPath, paths.coreConfigPath);
        setMessage("Tachyon Core started");
      }
      await refreshRuntime();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Start failed");
    }
  }

  async function startAllRuntime() {
    try {
      const errors = runtimePreflightErrors();
      if (errors.length > 0) {
        setMessage(errors[0]);
        return;
      }
      const paths = await writeDrafts();
      const settings = await saveRuntimeSettings(runtimeInputs);
      setRuntimeInputs(settings);

      if (!settings.xrayBinaryPath.trim()) {
        setMessage("Xray binary path required");
        return;
      }
      if (!settings.tachyonCoreBinaryPath.trim()) {
        setMessage("Core binary path required");
        return;
      }

      await startXray(settings.xrayBinaryPath, paths.xrayConfigPath);
      await startTachyonCore(settings.tachyonCoreBinaryPath, paths.coreConfigPath);
      setMessage("Xray and Tachyon Core started");
      await refreshRuntime();
    } catch (error) {
      await refreshRuntime();
      setMessage(error instanceof Error ? error.message : "Start all failed");
    }
  }

  async function stopRuntime(kind: "tachyonCore" | "xray") {
    try {
      if (kind === "xray") {
        await stopXray();
        setMessage("Xray stopped");
      } else {
        await stopTachyonCore();
        setMessage("Tachyon Core stopped");
      }
      await refreshRuntime();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Stop failed");
    }
  }

  async function stopAllRuntime() {
    try {
      await stopTachyonCore();
      await stopXray();
      setMessage("Xray and Tachyon Core stopped");
      await refreshRuntime();
    } catch (error) {
      await refreshRuntime();
      setMessage(error instanceof Error ? error.message : "Stop all failed");
    }
  }

  useEffect(() => {
    void refreshProfiles();
    void getConfigPaths()
      .then((paths) => setConfigPaths(paths))
      .catch(() => undefined);
    void getRuntimePaths()
      .then((paths) => {
        setRuntimePaths(paths);
        setRuntimeInputs({
          tachyonCoreBinaryPath: paths.tachyonCoreBinaryPath,
          xrayBinaryPath: paths.xrayBinaryPath,
        });
      })
      .catch(() => undefined);
    void getRuntimeSettings()
      .then((settings) => setRuntimeInputs(settings))
      .catch(() => undefined);
    void refreshManagedBinaries();
    void refreshRuntime();
  }, []);

  useEffect(() => {
    setSubscriptionUrl(subscription.sourceUrl === "manual" ? "" : subscription.sourceUrl);
  }, [subscription.sourceUrl]);

  useEffect(() => {
    const unsub = telemetryClient.subscribe(setTelemetry);
    telemetryClient.connect();
    return () => {
      unsub();
      telemetryClient.disconnect();
    };
  }, [telemetryClient]);

  const viewMeta: Record<
    PrismView,
    { eyebrow: string; label: string; subtitle: string; title: string }
  > = {
    overview: {
      eyebrow: "Dashboard",
      label: "Overview",
      subtitle: "Runtime health, selected egress, game acceleration and profile state.",
      title: "Overview",
    },
    nodes: {
      eyebrow: "Profiles",
      label: "Nodes",
      subtitle: "Import subscriptions, inspect parsed Xray nodes and choose the active route.",
      title: "Node Library",
    },
    game: {
      eyebrow: "Rules",
      label: "Game Mode",
      subtitle: "Manage manual game profiles and process-aware UDP acceleration rules.",
      title: "Game Mode",
    },
    launchers: {
      eyebrow: "Discovery",
      label: "Launchers",
      subtitle: "Scan Steam libraries and add detected games to Tachyon acceleration.",
      title: "Launchers",
    },
    runtime: {
      eyebrow: "Cores",
      label: "Runtime",
      subtitle: "Install, select and supervise Xray Core and Tachyon Core binaries.",
      title: "Runtime",
    },
    config: {
      eyebrow: "Generated",
      label: "Config",
      subtitle: "Review and save generated JSON config files for both managed cores.",
      title: "Config Drafts",
    },
  };

  const navItems: Array<{ badge?: number; id: PrismView }> = [
    { id: "overview" },
    { badge: subscription.nodes.length, id: "nodes" },
    { badge: activeProfiles, id: "game" },
    { badge: suggestions.length, id: "launchers" },
    { id: "runtime" },
    { id: "config" },
  ];
  const currentView = viewMeta[activeView];
  const connectionLabel =
    connection === "connected"
      ? "Connected"
      : connection === "checking"
        ? "Checking"
        : "Disconnected";
  const runtimeRows = [
    { label: "Xray Core", value: processStatusLabel(runtimeStatus?.xray) },
    { label: "Tachyon Core", value: processStatusLabel(runtimeStatus?.tachyonCore) },
  ];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <span className="brand-mark">T</span>
          <div>
            <h1>Tachyon Prism</h1>
            <p>Xray + Tachyon control plane</p>
          </div>
        </div>
        <nav className="side-nav" aria-label="Primary">
          {navItems.map((item) => (
            <button
              aria-current={item.id === activeView ? "page" : undefined}
              className={item.id === activeView ? "nav-item active" : "nav-item"}
              key={item.id}
              type="button"
              onClick={() => setActiveView(item.id)}
            >
              <span>{viewMeta[item.id].label}</span>
              {typeof item.badge === "number" ? <strong>{item.badge}</strong> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-status">
          <span className={`connection-pill ${connection}`}>{connectionLabel}</span>
          <strong>{message}</strong>
        </div>
      </aside>

      <section className="content-shell">
        <header className="page-header">
          <div>
            <span className="eyebrow">{currentView.eyebrow}</span>
            <h2>{currentView.title}</h2>
            <p>{currentView.subtitle}</p>
          </div>
          <div className="header-actions">
            <button type="button" onClick={() => void refreshProfiles()}>
              Refresh
            </button>
            <button type="button" onClick={() => void startAllRuntime()}>
              Start All
            </button>
            <button type="button" onClick={() => void stopAllRuntime()}>
              Stop All
            </button>
          </div>
        </header>

        <section className="view-stack">
          {activeView === "overview" ? (
            <div className="overview-layout">
              <article className="panel latency-panel">
                <header>
                  <div>
                    <h2>Status</h2>
                    <p>{message}</p>
                  </div>
                  <span className={`status-chip ${connection}`}>{connectionLabel}</span>
                </header>
                <div className="status-metrics">
                  <div>
                    <strong>{profiles.length}</strong>
                    <span>Profiles</span>
                  </div>
                  <div>
                    <strong>{activeProfiles}</strong>
                    <span>Active</span>
                  </div>
                  <div>
                    <strong>{suggestions.length}</strong>
                    <span>Suggestions</span>
                  </div>
                  <div>
                    <strong>{subscription.nodes.length}</strong>
                    <span>Nodes</span>
                  </div>
                </div>
                <div className="waveform" aria-label="latency waveform" />
              </article>
              </article>

              <article className="panel compact-panel">
                <header>
                  <h2>Live Telemetry</h2>
                  <span className={`status-chip ${telemetry.connection === "connected" ? "connected" : "disconnected"}`}>
                    {telemetry.connection}
                  </span>
                </header>
                {telemetry.latestTelemetry ? (
                  <TelemetryMetrics data={telemetry.latestTelemetry} />
                ) : (
                  <p className="muted">Waiting for telemetry stream...</p>
                )}
                {telemetry.recentRoutes.length > 0 ? (
                  <div className="route-list">
                    {telemetry.recentRoutes.slice(0, 5).map((route: RouteEventData, index: number) => (
                      <div className="route-row" key={index}>
                        <span className="route-decision">{route.decision}</span>
                        <span>{route.process_name}</span>
                        <span className="route-flow">{route.dst}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
              <div className="overview-side">
                <article className="panel compact-panel">
                  <header>
                    <h2>Selected Node</h2>
                    <button type="button" onClick={() => setActiveView("nodes")}>
                      Manage
                    </button>
                  </header>
                  {activeNode ? (
                    <div className="selected-node">
                      <strong>{activeNode.name}</strong>
                      <span>
                        {activeNode.protocol.toUpperCase()} {nodeEndpoint(activeNode)}
                        {activeNode.transport ? ` / ${activeNode.transport}` : ""}
                      </span>
                    </div>
                  ) : (
                    <div className="empty-state">No node selected</div>
                  )}
                </article>

                <article className="panel compact-panel">
                  <header>
                    <h2>Runtime</h2>
                    <button type="button" onClick={() => setActiveView("runtime")}>
                      Manage
                    </button>
                  </header>
                  <div className="runtime-status-list">
                    {runtimeRows.map((row) => (
                      <div key={row.label}>
                        <span>{row.label}</span>
                        <strong>{row.value}</strong>
                      </div>
                    ))}
                  </div>
                </article>

                <article className="panel compact-panel">
                  <header>
                    <h2>Game Mode</h2>
                    <button type="button" onClick={() => setActiveView("game")}>
                      Manage
                    </button>
                  </header>
                  <div className="runtime-status-list">
                    <div>
                      <span>UDP Policy</span>
                      <strong>TGP</strong>
                    </div>
                    <div>
                      <span>Enabled Profiles</span>
                      <strong>{activeProfiles}</strong>
                    </div>
                  </div>
                </article>

                <article className="panel compact-panel">
                  <header>
                    <h2>Readiness</h2>
                    <button type="button" onClick={() => setActiveView("runtime")}>
                      Review
                    </button>
                  </header>
                  <div className="runtime-status-list">
                    <div>
                      <span>Blocking items</span>
                      <strong>{readinessErrors}</strong>
                    </div>
                    <div>
                      <span>Checks</span>
                      <strong>{readinessItems.length}</strong>
                    </div>
                  </div>
                </article>
              </div>
            </div>
          ) : null}

          {activeView === "game" ? (
            <article className="panel">
              <header>
                <h2>Game Mode</h2>
                <button type="button" onClick={() => void addManualProfile()}>
                  Add Program
                </button>
              </header>
              <div className="form-grid">
                <input
                  placeholder="Display name"
                  value={manualProfile.displayName}
                  onChange={(event) =>
                    setManualProfile((current) => ({
                      ...current,
                      displayName: event.target.value,
                    }))
                  }
                />
                <input
                  placeholder="Process name"
                  value={manualProfile.processName}
                  onChange={(event) =>
                    setManualProfile((current) => ({
                      ...current,
                      processName: event.target.value,
                    }))
                  }
                />
                <input
                  className="wide-input"
                  placeholder="Executable path"
                  value={manualProfile.executablePath}
                  onChange={(event) =>
                    setManualProfile((current) => ({
                      ...current,
                      executablePath: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="profile-list">
                {profiles.map((profile) => (
                  <div className="profile-row" key={profile.id}>
                    <div>
                      <strong>{profile.displayName}</strong>
                      <span>{profileMatchLabel(profile)}</span>
                    </div>
                    <div className="row-actions">
                      <span>{profile.udpPolicy.toUpperCase()}</span>
                      <button type="button" onClick={() => void removeProfile(profile.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          ) : null}

          {activeView === "nodes" ? (
            <article className="panel">
              <header>
                <h2>Nodes</h2>
                <button type="button" onClick={() => void updateSubscriptionFromUrl()}>
                  Update
                </button>
              </header>
              <div className="form-grid">
                <input
                  className="wide-input"
                  placeholder="Subscription URL"
                  value={subscriptionUrl}
                  onChange={(event) => setSubscriptionUrl(event.target.value)}
                />
                <textarea
                  className="wide-input"
                  placeholder="Paste subscription payload"
                  value={subscriptionText}
                  onChange={(event) => setSubscriptionText(event.target.value)}
                />
                <button type="button" onClick={() => void importSubscriptionText()}>
                  Import
                </button>
              </div>
              {activeNode ? (
                <div className="selected-node">
                  <strong>{activeNode.name}</strong>
                  <span>
                    {activeNode.protocol.toUpperCase()} {nodeEndpoint(activeNode)}
                  </span>
                </div>
              ) : null}
              <div className="profile-list">
                {subscription.nodes.map((node) => (
                  <div className="profile-row" key={node.id}>
                    <div>
                      <strong>{node.name}</strong>
                      <span>
                        {node.protocol.toUpperCase()} {nodeEndpoint(node)}
                        {node.transport ? ` / ${node.transport}` : ""}
                      </span>
                    </div>
                    <button
                      className={node.id === subscription.selectedNodeId ? "active-button" : ""}
                      type="button"
                      onClick={() => chooseNode(node.id)}
                    >
                      {node.id === subscription.selectedNodeId ? "Selected" : "Select"}
                    </button>
                  </div>
                ))}
              </div>
            </article>
          ) : null}

          {activeView === "launchers" ? (
            <article className="panel">
              <header>
                <h2>Launchers</h2>
                <button type="button" onClick={() => void scanSteam()}>
                  Scan Steam
                </button>
              </header>
              <input
                className="full-input"
                placeholder="Steam root"
                value={steamRoot}
                onChange={(event) => setSteamRoot(event.target.value)}
              />
              <div className="switch-row">
                <span>Steam launcher detection</span>
                <input
                  type="checkbox"
                  checked={launcherSettings.steam.enabled}
                  onChange={(event) =>
                    updateSteamLauncherSetting("enabled", event.currentTarget.checked)
                  }
                />
              </div>
              <div className="switch-row">
                <span>Steam child process tracking</span>
                <input
                  type="checkbox"
                  checked={launcherSettings.steam.trackChildProcesses}
                  disabled={!launcherSettings.steam.enabled}
                  onChange={(event) =>
                    updateSteamLauncherSetting("trackChildProcesses", event.currentTarget.checked)
                  }
                />
              </div>
              <div className="switch-row">
                <span>Accelerate Steam game UDP</span>
                <input
                  type="checkbox"
                  checked={launcherSettings.steam.accelerateGameUdp}
                  disabled={!launcherSettings.steam.enabled}
                  onChange={(event) =>
                    updateSteamLauncherSetting("accelerateGameUdp", event.currentTarget.checked)
                  }
                />
              </div>
              <div className="switch-row">
                <span>Accelerate Steam downloads</span>
                <input
                  type="checkbox"
                  checked={launcherSettings.steam.accelerateSteamDownloads}
                  disabled={!launcherSettings.steam.enabled}
                  onChange={(event) =>
                    updateSteamLauncherSetting(
                      "accelerateSteamDownloads",
                      event.currentTarget.checked,
                    )
                  }
                />
              </div>
              <div className="suggestion-list">
                {suggestions.map((profile) => (
                  <div className="profile-row" key={profile.id}>
                    <div>
                      <strong>{profile.displayName}</strong>
                      <span>{profileMatchLabel(profile)}</span>
                    </div>
                    <button type="button" onClick={() => void addSuggestion(profile)}>
                      Add
                    </button>
                  </div>
                ))}
              </div>
            </article>
          ) : null}

          {activeView === "runtime" ? (
            <>
              <article className="panel readiness-panel">
                <header>
                  <div>
                    <h2>Readiness</h2>
                    <p>{readinessErrors === 0 ? "Ready to start" : `${readinessErrors} item needs attention`}</p>
                  </div>
                  <button type="button" onClick={() => void refreshManagedBinaries()}>
                    Refresh
                  </button>
                </header>
                <div className="readiness-list">
                  {readinessItems.map((item) => (
                    <div className={`readiness-row ${item.state}`} key={item.label}>
                      <span>{readinessText(item.state)}</span>
                      <div>
                        <strong>{item.label}</strong>
                        <p>{item.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </article>

              <article className="panel binary-panel">
                <header>
                  <h2>Binaries</h2>
                  <div className="row-actions">
                    <button type="button" onClick={() => void refreshManagedBinaries()}>
                      Refresh
                    </button>
                  </div>
                </header>
                {managedBinaries ? (
                  <div className="path-list">
                    <div>
                      <span>managed bin</span>
                      <strong>{managedBinaries.binDir}</strong>
                    </div>
                  </div>
                ) : null}
                <div className="binary-grid">
                  {managedBinaryKinds.map((kind) => {
                    const binary = binaryInfo(kind);
                    const displayName = binary?.displayName ?? managedBinaryDisplayName(kind);
                    const release = binaryReleases[kind];
                    return (
                      <div className="binary-row" key={kind}>
                        <div className="binary-meta">
                          <strong>{displayName}</strong>
                          <span>{binary ? managedStatusLabel(binary) : "inventory unavailable"}</span>
                          {binary ? <span>{configuredStatusLabel(binary)}</span> : null}
                          {binary ? <span>{binary.targetPath}</span> : null}
                          {binary?.sidecarDependencies.map((dependency) => (
                            <span key={dependency.name}>
                              {dependency.name}: {dependency.exists ? "found" : dependency.path}
                            </span>
                          ))}
                          {release ? (
                            <span>
                              Latest {release.tagName}: {release.assetName} /{" "}
                              {formatBytes(release.assetSizeBytes)}
                            </span>
                          ) : null}
                        </div>
                        <input
                          placeholder="Source binary path"
                          value={binarySourceInputs[kind]}
                          onChange={(event) =>
                            setBinarySourceInputs((current) => ({
                              ...current,
                              [kind]: event.target.value,
                            }))
                          }
                        />
                        <div className="row-actions">
                          <button type="button" onClick={() => void installBinary(kind)}>
                            Install
                          </button>
                          <button type="button" onClick={() => void useManagedBinary(kind)}>
                            Use Managed
                          </button>
                          <button
                            type="button"
                            disabled={binaryBusy}
                            onClick={() => void checkLatestRelease(kind)}
                          >
                            Check Latest
                          </button>
                          <button
                            type="button"
                            disabled={binaryBusy}
                            onClick={() => void downloadLatestRelease(kind)}
                          >
                            Install Latest
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </article>

              <article className="panel runtime-panel">
                <header>
                  <h2>Runtime</h2>
                  <div className="row-actions">
                    <button type="button" onClick={() => void saveRuntimeInputs()}>
                      Save Paths
                    </button>
                    <button type="button" onClick={() => void startAllRuntime()}>
                      Start All
                    </button>
                    <button type="button" onClick={() => void stopAllRuntime()}>
                      Stop All
                    </button>
                    <button type="button" onClick={() => void refreshRuntime()}>
                      Refresh
                    </button>
                  </div>
                </header>
                {runtimePaths ? (
                  <div className="path-list">
                    <div>
                      <span>bin</span>
                      <strong>{runtimePaths.binDir}</strong>
                    </div>
                    <div>
                      <span>runtime-settings.json</span>
                      <strong>{runtimePaths.runtimeSettingsPath}</strong>
                    </div>
                  </div>
                ) : null}
                <div className="runtime-grid">
                  <div className="runtime-row">
                    <div>
                      <strong>Xray Core</strong>
                      <span>{processStatusLabel(runtimeStatus?.xray)}</span>
                    </div>
                    <input
                      placeholder="Xray binary"
                      value={runtimeInputs.xrayBinaryPath}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({
                          ...current,
                          xrayBinaryPath: event.target.value,
                        }))
                      }
                    />
                    <div className="row-actions">
                      <button type="button" onClick={() => void startRuntime("xray")}>
                        Start
                      </button>
                      <button type="button" onClick={() => void stopRuntime("xray")}>
                        Stop
                      </button>
                    </div>
                  </div>
                  <div className="runtime-row">
                    <div>
                      <strong>Tachyon Core</strong>
                      <span>{processStatusLabel(runtimeStatus?.tachyonCore)}</span>
                    </div>
                    <input
                      placeholder="Tachyon Core binary"
                      value={runtimeInputs.tachyonCoreBinaryPath}
                      onChange={(event) =>
                        setRuntimeInputs((current) => ({
                          ...current,
                          tachyonCoreBinaryPath: event.target.value,
                        }))
                      }
                    />
                    <div className="row-actions">
                      <button type="button" onClick={() => void startRuntime("tachyonCore")}>
                        Start
                      </button>
                      <button type="button" onClick={() => void stopRuntime("tachyonCore")}>
                        Stop
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            </>
          ) : null}

          {activeView === "config" ? (
            <article className="panel config-panel">
              <header>
                <h2>Config</h2>
                <div className="row-actions">
                  <button type="button" onClick={() => void saveDrafts()}>
                    Save
                  </button>
                  <button type="button" onClick={() => void copyDraft("Xray config", drafts.xray)}>
                    Copy Xray
                  </button>
                  <button type="button" onClick={() => void copyDraft("Core config", drafts.core)}>
                    Copy Core
                  </button>
                </div>
              </header>
              {drafts.error ? <div className="inline-error">{drafts.error}</div> : null}
              {configPaths ? (
                <div className="path-list">
                  <div>
                    <span>client.json</span>
                    <strong>{configPaths.coreConfigPath}</strong>
                  </div>
                  <div>
                    <span>xray-client.json</span>
                    <strong>{configPaths.xrayConfigPath}</strong>
                  </div>
                </div>
              ) : null}
              <div className="config-grid">
                <label>
                  <span>Xray</span>
                  <textarea readOnly value={drafts.xray} />
                </label>
                <label>
                  <span>Core</span>
                  <textarea readOnly value={drafts.core} />
                </label>
              </div>
            </article>
          ) : null}
        </section>
      </section>
    </main>
  );
}


