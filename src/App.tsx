import { useEffect, useMemo, useState } from "react";
import { coreApi } from "./domain/coreApi";
import {
  buildCoreClientConfigDraft,
  buildXrayClientConfigDraft,
  stringifyDraft,
} from "./domain/configDrafts";
import type { GameProfile } from "./domain/gameProfiles";
import { defaultGameProfiles } from "./domain/gameProfiles";
import {
  createSubscriptionSnapshot,
  fetchSubscriptionNodes,
  loadSubscriptionSnapshot,
  parseSubscription,
  saveSubscriptionSnapshot,
  selectSubscriptionNode,
} from "./domain/subscriptions";
import type { ProxyNode, SubscriptionSnapshot } from "./domain/subscriptions";

type ConnectionState = "checking" | "connected" | "disconnected";

const emptyProfile = {
  displayName: "",
  processName: "",
  executablePath: "",
};

function selectedNode(snapshot: SubscriptionSnapshot): ProxyNode | undefined {
  return snapshot.nodes.find((node) => node.id === snapshot.selectedNodeId);
}

function nodeEndpoint(node: ProxyNode): string {
  return node.port > 0 ? `${node.address}:${node.port}` : node.address;
}

function draftText(activeNode: ProxyNode | undefined): {
  core: string;
  error: string;
  xray: string;
} {
  if (!activeNode) {
    return { core: "", error: "", xray: "" };
  }

  try {
    return {
      core: stringifyDraft(buildCoreClientConfigDraft(activeNode)),
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

export function App() {
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [profiles, setProfiles] = useState<GameProfile[]>(defaultGameProfiles);
  const [suggestions, setSuggestions] = useState<GameProfile[]>([]);
  const [steamRoot, setSteamRoot] = useState("");
  const [manualProfile, setManualProfile] = useState(emptyProfile);
  const [subscription, setSubscription] = useState(loadSubscriptionSnapshot);
  const [subscriptionUrl, setSubscriptionUrl] = useState("");
  const [subscriptionText, setSubscriptionText] = useState("");
  const [message, setMessage] = useState("Ready");

  const activeProfiles = useMemo(
    () => profiles.filter((profile) => profile.enabled).length,
    [profiles],
  );
  const activeNode = useMemo(() => selectedNode(subscription), [subscription]);
  const drafts = useMemo(() => draftText(activeNode), [activeNode]);

  async function refreshProfiles() {
    try {
      const nextProfiles = await coreApi.listGameProfiles();
      setProfiles(nextProfiles);
      setConnection("connected");
      setMessage("Core connected");
    } catch (error) {
      setConnection("disconnected");
      setMessage(error instanceof Error ? error.message : "Core unavailable");
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
      await coreApi.addGameProfile(profile);
      setManualProfile(emptyProfile);
      await refreshProfiles();
      setMessage("Profile added");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Add failed");
    }
  }

  async function removeProfile(id: string) {
    try {
      await coreApi.removeGameProfile(id);
      await refreshProfiles();
      setMessage("Profile removed");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Remove failed");
    }
  }

  async function scanSteam() {
    try {
      const result = await coreApi.scanSteam(steamRoot);
      setSuggestions(result.profiles);
      setConnection("connected");
      setMessage(`${result.apps.length} Steam apps found`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Steam scan failed");
    }
  }

  async function addSuggestion(profile: GameProfile) {
    try {
      await coreApi.addGameProfile({
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

  useEffect(() => {
    void refreshProfiles();
  }, []);

  useEffect(() => {
    setSubscriptionUrl(subscription.sourceUrl === "manual" ? "" : subscription.sourceUrl);
  }, [subscription.sourceUrl]);

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>Tachyon Prism</h1>
          <p>{connection === "connected" ? "Core connected" : "Core disconnected"}</p>
        </div>
        <button type="button" onClick={() => void refreshProfiles()}>
          Connect Core
        </button>
      </section>

      <section className="dashboard-grid">
        <article className="panel latency-panel">
          <header>
            <h2>Status</h2>
            <span>{message}</span>
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
                  <span>
                    {[...profile.match.processNames, ...profile.match.paths]
                      .filter(Boolean)
                      .join(", ") || profile.match.steamAppIds.map((id) => `Steam ${id}`).join(", ")}
                  </span>
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
                  type="button"
                  className={node.id === subscription.selectedNodeId ? "active-button" : ""}
                  onClick={() => chooseNode(node.id)}
                >
                  {node.id === subscription.selectedNodeId ? "Selected" : "Select"}
                </button>
              </div>
            ))}
          </div>
        </article>

        <article className="panel config-panel">
          <header>
            <h2>Config</h2>
            <div className="row-actions">
              <button type="button" onClick={() => void copyDraft("Xray config", drafts.xray)}>
                Copy Xray
              </button>
              <button type="button" onClick={() => void copyDraft("Core config", drafts.core)}>
                Copy Core
              </button>
            </div>
          </header>
          {drafts.error ? <div className="inline-error">{drafts.error}</div> : null}
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
            <span>Steam child process tracking</span>
            <input type="checkbox" defaultChecked />
          </div>
          <div className="switch-row">
            <span>Accelerate Steam downloads</span>
            <input type="checkbox" />
          </div>
          <div className="suggestion-list">
            {suggestions.map((profile) => (
              <div className="profile-row" key={profile.id}>
                <div>
                  <strong>{profile.displayName}</strong>
                  <span>{profile.match.steamAppIds.map((id) => `Steam ${id}`).join(", ")}</span>
                </div>
                <button type="button" onClick={() => void addSuggestion(profile)}>
                  Add
                </button>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}
