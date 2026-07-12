# Getting Started with Tachyon Prism

[中文说明](getting-started.zh-CN.md)

## Prerequisites

- Windows 10/11, macOS 13+, or Linux
- A proxy subscription, individual share links, or full Xray outbound/config JSON

## 1. Install Tachyon Prism

Download the latest Prism release for your platform from the GitHub releases page, then run the installer.

## 2. Import a subscription

1. Open Prism and go to the **Subscriptions** view.
2. Enter a subscription name and URL, then click **Update**, or paste a subscription payload and click **Import**.
3. Select a node from the list. The selected node determines the Xray outbound; Tachyon game acceleration uses the separate Tachyon server profile.

## 3. Scan Steam (optional)

1. Go to **Settings > Rules**.
2. Click **Scan Steam**. Prism automatically detects Steam roots on your system.
3. Review the suggested game profiles and click **Add** to accelerate the games you want.

## 4. Add game profiles

Go to **Settings > Rules** and add a manual profile:

- **Display name**: a label for the game.
- **Process name**: the executable, for example `cs2.exe`.
- **Executable path**: full path to the game executable, optional.

At least one match rule is required. UDP defaults to Tachyon/TGP game acceleration.

## 5. Install binaries

Go to **Settings > Core** and scroll to **Binaries**:

1. Choose `stable` or `preview` for each core.
2. **Install Latest Xray** downloads, SHA-256 verifies, and extracts the latest Xray Core release.
3. **Install Latest Tachyon Core** does the same for Tachyon Core.
4. Click **Use Managed** to point the runtime path at the installed binary.
5. Use **Diagnose** to inspect the saved release channel, resolved tag, asset,
   checksum, installed path, version status, and last error without writing
   settings, launching cores, executing installed binaries, or enabling system
   proxy/TUN.

On Windows, Prism also checks the required `wintun.dll` sidecar for Tachyon Core.
Prism also shows whether the current desktop process has enough privilege to
create TUN devices, but TUN takeover remains disabled in the current alpha.
You do not need Administrator/root just to run Xray or optional Tachyon game
acceleration with the generated alpha configs.

## 6. Generate, validate, and save configs

Go to **Settings > Core** and find **Config Drafts**:

- Prism generates `xray-client.json` and `client.json` from your selected Xray node, Tachyon server profile, game profiles, launcher settings, runtime ports, TGP local bind addresses, connection migration, and the multipath switch.
- Click **Save** to write them to the Prism config directory.
- Click **Validate Configs** to run `xray run -test -config` and `tachyon-core validate --config` before launching.
- You can also **Copy** either config to the clipboard.

## 7. Start the cores

Use the Overview quick actions or **Settings > Core** runtime buttons:

1. Prism writes the latest config files.
2. Prism validates `xray-client.json` with Xray's native test mode.
3. Prism validates `client.json` with Tachyon Core's validator.
4. Prism starts Xray Core and waits for local Xray readiness.
5. Prism starts Tachyon Core only after Xray is ready, then waits for the local
   Core `/v1/health` readiness endpoint.
6. Any start or readiness failure rolls back the cores started by **Start All**.
7. The dashboard shows live status for both cores.

Game UDP traffic matching your profiles will be accelerated through TGP. Other proxy traffic flows through Xray.

## Verifying

- The **Overview** view shows runtime status, enabled game profiles, and dual-core traffic curves.
- The **Readiness** panel flags missing nodes, binaries, configs, and sidecars.
- The **TUN Privilege** row is read-only in alpha and is not a startup gate.
- The local HTTP/SOCKS proxy probe validates Xray through the generated local inbounds without changing system proxy or enabling TUN.
- Windows system proxy control is implemented in the UI as an alpha WinINet transaction with snapshot, verification, restore, and crash recovery. It has not completed real-host registry acceptance testing and is not production-ready.
- macOS and Linux system proxy control are unsupported.
- TUN one-click takeover remains disabled and is a stable gate, not part of this release loop.
- Real VPS, real client, and real game UDP acceleration paths still need field testing.
