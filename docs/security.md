# Tachyon Prism Security Model

This document describes the security boundaries enforced by the desktop backend. Security reports should avoid attaching subscription URLs, node URIs, Xray JSON, Tachyon PSKs, or runtime logs containing credentials.

## Runtime ownership

The system proxy is owned exclusively by the managed Xray process. Prism refuses to enable it unless Xray is running. Stopping or failing Tachyon Core does not modify an Xray-owned proxy transaction. Prism restores the previous proxy snapshot before stopping Xray, when Xray is observed stopped or failed, and during application shutdown or crash recovery.

Tachyon Core never owns the operating-system proxy. It transports selected game UDP traffic only.

## Subscription network policy

Subscription downloads run in the Rust backend and accept only HTTP and HTTPS URLs without embedded credentials. Every request and redirect is parsed, resolved, and validated independently. The approved socket addresses are then injected into the HTTP client's resolver, binding validation to the actual connection while preserving TLS hostname verification.

Prism rejects loopback, unspecified, private, shared, link-local, multicast, documentation, benchmarking, reserved, and cloud metadata destinations by default for both IPv4 and IPv6. Redirects cannot downgrade HTTPS to HTTP. Cloud metadata addresses and hostnames remain forbidden under every policy.

Private or local subscription endpoints are not enabled in this release. A future implementation must expose a clearly labelled, persisted opt-in that defaults to off; it must not relax metadata, link-local, multicast, documentation, or reserved-address protections.

## Subscription configuration trust boundary

Remote subscription payloads are untrusted node sources, not Xray control-plane
configuration. When a payload contains a complete Xray object, Prism retains
only recognized outbound objects. It discards every remote top-level control,
including inbounds, API, reverse, log paths, policy, stats, transport,
observatory, and unknown fields. Stored snapshots are normalized again when
loaded so legacy data cannot restore those controls.

Complete Xray JSON is supported only by the local advanced editor. Enabling the
editor is not sufficient: every content change clears its confirmation, and the
user must explicitly confirm the warning before commit. The Rust command checks
this mode and confirmation independently of the renderer.

Before validation or process start, Rust validates the final generation
`ApplyPlan`. A managed plan may contain only Prism-owned numeric loopback
SOCKS/HTTP listeners, the optional Prism StatsService listener and controls,
recognized outbounds, and Prism routing. Extra or duplicate listeners,
non-loopback binds, API/reverse controls, dangerous log paths, and unknown
top-level controls fail closed. The Tachyon Core start command likewise runs
Core preflight internally, including when invoked directly.

## Renderer policy

The Tauri renderer uses an explicit Content Security Policy. Scripts load only from the packaged application. Network connections are limited to Tauri IPC and loopback runtime endpoints used by Tachyon telemetry. Arbitrary remote HTTP(S), `unsafe-eval`, frames, objects, and forms are blocked. Remote downloads are performed by validated Rust commands rather than renderer `fetch`.

## Sensitive files and diagnostics

Runtime settings, Xray configuration, Tachyon configuration, proxy recovery journals, and atomic candidates use the common secure writer. Files are mode `0600` on Unix. On Windows, Prism applies a protected DACL granting full access only to the current user, Local System, and Administrators. Atomic replacement reapplies the policy to the canonical file.

## Credential-protected vault

Subscription URLs, node URIs, complete imported Xray outbound data, advanced Xray JSON drafts, Tachyon server profiles, and TGP PSKs are never persisted in WebView `localStorage`. Prism stores only non-sensitive preferences and identifiers there.

Prism creates a random 256-bit master key and stores that small key in the operating-system credential service through `keyring 4.1.5`: Windows Credential Manager, macOS Keychain, or Linux Secret Service. The potentially large data set is serialized into a versioned vault under the application data directory and authenticated-encrypted with RustCrypto `XChaCha20-Poly1305` (`chacha20poly1305 0.11.0`). Every write uses a fresh 192-bit nonce, fixed versioned associated data, an atomic replace, owner-only file permissions, and a decrypt-and-compare verification pass. Secret byte buffers are zeroized where their representation permits it.

Prism does not store the subscription corpus directly as a credential entry and does not implement its own cipher. If the credential service is unavailable, the key is missing, authentication fails, or the vault cannot be verified, the operation fails closed; there is no plaintext file or WebView fallback.

Linux packages use the `keyring 4.1.5` zbus Secret Service backend. A compatible
provider must be available in the user's D-Bus session; GNOME Keyring and
Secret-Service-compatible KWallet deployments are examples. A package install
does not create or unlock a desktop keyring on the user's behalf. Missing,
locked, or unreachable Secret Service providers therefore produce the same
fail-closed behavior described above.

CI and release workflows exercise the production platform backends directly.
Each run creates a cryptographically unique service, account, and value; writes,
reads, compares, deletes, and confirms absence; and never enumerates or reads
pre-existing user credentials. Windows uses Credential Manager, macOS uses a
temporary Keychain that is removed after the test, and Linux starts GNOME
Keyring inside an isolated `dbus-run-session`. This live test is both feature-
gated and ignored by default, so ordinary `cargo test` never touches the system
credential store.

On first launch after this change, the Rust backend imports the legacy subscription snapshot, Tachyon profiles, advanced Xray draft, and runtime TGP PSK. The renderer removes an old `localStorage` value only after the encrypted write has been read back and compared with that exact section. Failed or conflicting migrations retain the legacy value and show a localized error so the user can retry without losing data. Repeated migration is idempotent.

The generated Xray and Tachyon runtime configuration files must still exist temporarily for their respective cores. They use the protected-file policy above and are not WebView persistence.

Xray diagnostics are redacted and bounded before reaching the UI. New backend errors must never include configuration bodies, PSKs, subscription credentials, node URIs, or authorization headers.
