# Getting Started with Tachyon Prism

[中文说明](getting-started.zh-CN.md)

## Prerequisites

- Windows 10/11, macOS 13+, or Linux with kernel TUN support
- A proxy subscription (VLESS, VMess, Trojan, SS, or full Xray JSON)

## 1. Install Tachyon Prism

Download the latest Prism release for your platform from the GitHub releases page.
Run the installer.

## 2. Import a subscription

1. Open Prism and go to the **Nodes** view.
2. Paste a subscription URL into the input and click **Update**, or paste a
   subscription payload directly and click **Import**.
3. Select a node from the list. The selected node determines the Xray outbound
   and TGP relay endpoint.

## 3. Scan Steam (optional)

1. Go to the **Launchers** view.
2. Click **Scan Steam**. Prism automatically detects Steam roots on your system.
3. Review the suggested game profiles and click **Add** to promote any you want
   to accelerate.

## 4. Add game profiles

Go to the **Game Mode** view and add a manual profile:

- **Display name**: a label for the game.
- **Process name**: the executable (e.g. `cs2.exe`).
- **Executable path**: full path to the game executable (optional).

At least one match rule is required. UDP defaults to TGP (game acceleration).

## 5. Install binaries

Go to the **Runtime** view and scroll to the **Binaries** section:

1. **Install Latest Xray**: downloads, SHA-256 verifies, and extracts the latest
   Xray Core release.
2. **Install Latest Tachyon Core**: same for Tachyon Core.
3. Click **Use Managed** to point the runtime path at the installed binary.

On Windows, Prism also detects the required `wintun.dll` sidecar.

## 6. Generate and save configs

Go to the **Config** view:

- Prism generates `xray-client.json` and `client.json` from your selected node,
  game profiles, and launcher settings.
- Click **Save** to write them to the Prism config directory.
- You can also **Copy** either config to the clipboard.

## 7. Start the cores

Go to the **Runtime** view and click **Start All**:

1. Prism writes the latest config files.
2. Prism starts Xray Core with `xray-client.json`.
3. Prism starts Tachyon Core with `client.json`.
4. The dashboard shows live status for both cores.

Game UDP traffic matching your profiles will now be accelerated through TGP.
All other traffic flows through Xray normally.

## Verifying

- The **Overview** view shows runtime status and enabled game profiles.
- The **Runtime** view shows process state (running/stopped) for each core.
- The **Readiness** panel flags any missing binaries, configs, or sidecars.
