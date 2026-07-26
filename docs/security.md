# Tachyon Prism Security Model

This document describes the security boundaries enforced by the desktop backend. Security reports should avoid attaching subscription URLs, node URIs, Xray JSON, Tachyon PSKs, or runtime logs containing credentials.

## Runtime ownership

The system proxy is owned exclusively by the managed Xray process. Prism refuses to enable it unless Xray is running. Stopping or failing Tachyon Core does not modify an Xray-owned proxy transaction. Prism restores the previous proxy snapshot before stopping Xray, when Xray is observed stopped or failed, and during application shutdown or crash recovery.

Tachyon Core never owns the operating-system proxy. It transports selected game UDP traffic only.

## Subscription network policy

Subscription downloads run in the Rust backend and accept only HTTP and HTTPS URLs without embedded credentials. Every request and redirect is parsed, resolved, and validated independently. The approved socket addresses are then injected into the HTTP client's resolver, binding validation to the actual connection while preserving TLS hostname verification.

Prism rejects loopback, unspecified, private, shared, link-local, multicast, documentation, benchmarking, reserved, and cloud metadata destinations by default for both IPv4 and IPv6. Redirects cannot downgrade HTTPS to HTTP. Cloud metadata addresses and hostnames remain forbidden under every policy.

Private or local subscription endpoints are not enabled in this release. A future implementation must expose a clearly labelled, persisted opt-in that defaults to off; it must not relax metadata, link-local, multicast, documentation, or reserved-address protections.

## Renderer policy

The Tauri renderer uses an explicit Content Security Policy. Scripts load only from the packaged application. Network connections are limited to Tauri IPC and loopback runtime endpoints used by Tachyon telemetry. Arbitrary remote HTTP(S), `unsafe-eval`, frames, objects, and forms are blocked. Remote downloads are performed by validated Rust commands rather than renderer `fetch`.

## Sensitive files and diagnostics

Runtime settings, Xray configuration, Tachyon configuration, proxy recovery journals, and atomic candidates use the common secure writer. Files are mode `0600` on Unix. On Windows, Prism applies a protected DACL granting full access only to the current user, Local System, and Administrators. Atomic replacement reapplies the policy to the canonical file.

Xray diagnostics are redacted and bounded before reaching the UI. New backend errors must never include configuration bodies, PSKs, subscription credentials, node URIs, or authorization headers.

Credential migration from renderer storage to an operating-system credential vault is tracked separately and is not claimed by this document.
