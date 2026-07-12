# Tachyon Prism Alpha Client Test Plan

This plan covers the real client alpha loop for Tachyon Prism `alpha.15`.
Prism and Tachyon Core are still alpha-stage for real VPS and real game UDP
acceleration. Do not treat this as a stable or complete release claim.

## Scope

Use this plan to install Prism, verify the downloaded artifact, import an Xray
subscription, probe local Xray HTTP/SOCKS inbounds, configure a Tachyon server
profile, and collect redacted logs/screenshots/diagnostics.

Windows system proxy control is implemented and connected to the UI as an alpha
WinINet transaction, but real-host registry acceptance has not been performed
and is outside this test loop. macOS and Linux system proxy control are
unsupported. TUN one-click takeover remains disabled and is a stable gate.

## Download and Verify `alpha.15`

1. Download the Prism `alpha.15` artifact for your platform from the project
   release page.
2. Download `SHA256SUMS.txt` from the same release.
3. Verify the artifact before installing.

Linux/macOS:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

Windows PowerShell:

```powershell
Get-FileHash .\Tachyon-Prism-*.exe -Algorithm SHA256
```

Compare the printed SHA-256 with the matching line in `SHA256SUMS.txt`.

Current artifacts may be unsigned. Windows SmartScreen and macOS Gatekeeper can
warn until signing/notarization is added.

## Install and First Launch

1. Install or extract the verified artifact.
2. Launch Prism.
3. Record the Prism version/build shown by the release artifact or UI.
4. Open the Overview and Settings/Core views.
5. Confirm the alpha boundary: Windows system proxy host acceptance and TUN
   takeover are not part of this test loop.

## Import Subscription and Select Node

1. Open **Subscriptions**.
2. Import from a subscription URL or paste a subscription payload.
3. Select one node for Xray.
4. Confirm Prism shows the selected node in the runtime/config areas.

Do not send the full subscription URL, token, or complete node secrets back to
the project. If needed, share only the scheme, transport type, redacted host,
and visible import errors.

## Xray Local HTTP/SOCKS Probe

1. Install or select an Xray Core binary from **Settings > Core > Binaries**.
2. Save and validate generated configs.
3. Start Xray, or use **Start All** if Tachyon Core is also configured.
4. Run the local proxy probe from Overview.
5. Record both HTTP and SOCKS probe results: status, latency, and error text.

When using **Start All**, Prism requires local Xray readiness before starting
Tachyon Core, then requires Core `/v1/health` readiness. Any start or readiness
failure rolls back the cores already started by that transaction.

The probe uses Prism-generated local Xray inbounds only. It does not enable the
OS system proxy and does not enable Tachyon TUN.

## Core Release Diagnostics

Use **Diagnose** for Xray Core and Tachyon Core in **Settings > Core > Binaries**.

Check both relevant release-channel behaviors:

- `stable`: skips GitHub prereleases. If only alpha Tachyon Core releases exist,
  it should show an empty/error state that points users to `preview` instead of
  silently installing a prerelease.
- `preview` / `pre`: accepts prerelease builds and should be used for Tachyon
  Core while Core remains alpha-stage.

Diagnostics are read-only/no-spawn. They use saved runtime settings and report
channel, resolved tag, asset, checksum status, installed path, version status,
and last error. They do not write settings, generate configs, start either
core, execute installed binaries, enable system proxy, or enable Tachyon TUN.

## Client Diagnostics Export

Use **Settings > Core > Client Diagnostics > Export diagnostics** when you need
to send a support package back to the project.

The export is read-only/no-spawn/no-proxy/no-TUN. It uses the current Prism UI
state and already collected diagnostics only. It does not write runtime
settings, generate configs, start Xray or Tachyon Core, execute installed
binaries, enable the OS system proxy, or enable Tachyon TUN.

The JSON support package includes Prism version/platform, selected release
channels, configured/managed Core and Xray paths, Core release diagnostics
summaries, subscription group and node counts, protocol counts, a redacted
selected-node summary, recent errors, and the most recent local proxy probe
result if one exists.

Review the file before sending it. The exporter redacts subscription URL query
values, UUIDs, passwords, tokens, private keys, PSKs, and similar fields, but do
not add full subscription payloads, complete share links, server PSKs, or private
keys to your report.

## Tachyon Server Profile

Create a Tachyon server profile that matches a deployed Core VPS:

- Name: a local label.
- Address: VPS IP or domain.
- Port: the UDP listen port opened on the VPS.
- PSK: copy from the VPS `tgp.auth.psk`.
- Transport options: leave defaults unless the test coordinator requested a
  specific alpha setting.

The server must have explicit `allowed_targets` configured for the game UDP
destinations you plan to test. Prism cannot validate the server-side ACL from
the subscription node list.

Never send the PSK back. In screenshots, hide the PSK field.

## Game Mode and Manual Rules

Use either Steam scan suggestions or manual rules:

1. Open **Settings > Rules**.
2. Add or select a game profile.
3. Confirm the process name or executable path matches the game you will start.
4. Keep UDP acceleration enabled for the test profile.
5. Save configs and validate before launch.

For manual rules, record the process name, whether the executable path was set,
and whether the game was launched directly or through Steam. Redact local user
names from paths if needed.

## Test Boundary

For this alpha client loop:

- Do test subscription import, node selection, Xray config generation, local
  HTTP/SOCKS probe, Core release diagnostics, Tachyon server profile, config
  validation, launch/stop behavior, and game/manual rule matching.
- Do not treat the implemented Windows system proxy UI as host-accepted or
  production-ready; this loop does not toggle the host registry.
- Treat macOS and Linux system proxy control as unsupported.
- Do not enable Tachyon TUN one-click takeover.
- Do not claim stable, production-ready, or complete game acceleration.

## Output to Send Back

Send:

- OS version and architecture.
- Prism artifact name and SHA-256 verification result.
- Prism version/build and Tachyon Core/Xray Core versions or release tags.
- Subscription import result with secrets redacted.
- Selected Xray node summary: scheme, transport, redacted host/region if useful.
- Local HTTP and SOCKS probe result: status, latency, and error text.
- Core release diagnostics text for Xray and Tachyon Core.
- The exported Prism diagnostics JSON support package, after reviewing that it
  does not contain full subscriptions or secrets.
- Config validation result for `xray-client.json` and `client.json`.
- Tachyon server profile summary: redacted address, UDP port, PSK present yes/no,
  and whether the VPS `allowed_targets` were configured.
- Game profile/manual rule summary.
- Relevant Prism logs, Core/Xray stderr snippets, and screenshots with secrets
  hidden.

Do not send:

- Tachyon server PSK.
- Full subscription URL, token, or complete share links.
- Private keys, passwords, account IDs, or unrelated host inventory.
- Screenshots that reveal hidden tokens in text fields.
