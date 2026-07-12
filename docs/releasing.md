# Prism Release Process

## Channels and tags

The release workflow accepts only these existing Git tags:

- Stable: `vMAJOR.MINOR.PATCH`, for example `v0.1.0`.
- Prerelease: `vMAJOR.MINOR.PATCH-(alpha|beta|rc|pre|preview)[.N]`, for example
  `v0.1.0-alpha.1` or `v0.1.0-rc.2`.

The version before the suffix must match `package.json`,
`src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. Tag pushes derive the
channel from the tag. A manual dispatch requires both an existing tag and a
channel; a mismatch fails before tests or builds start. Manual runs check out
the tag itself, not the branch from which the workflow was started.

Stable releases are marked as GitHub's latest release. Prereleases are marked
as prereleases and explicitly excluded from latest. Editing an existing release
also resets both flags from the validated tag, so a rerun cannot retain stale
channel metadata.

## Build matrix

| Download label | GitHub runner | Rust target | Published package |
| --- | --- | --- | --- |
| Windows x64 | `windows-latest` | `x86_64-pc-windows-msvc` | NSIS `.exe`, MSI `.msi` |
| Windows ARM64 | `windows-11-arm` | `aarch64-pc-windows-msvc` | NSIS `.exe` |
| macOS x64 | `macos-15-intel` | `x86_64-apple-darwin` | `.dmg` |
| macOS ARM64 | `macos-15` | `aarch64-apple-darwin` | `.dmg` |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | Debian `.deb` |
| Linux ARM64 | `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` | Debian `.deb` |

CI runs Rust check and tests on the same six runner/target pairs. The static
release contract test compares the CI and release matrices and fails if they
drift. GitHub currently classifies its standard Windows and Linux ARM64 runners
as public preview, so repository/organization runner availability still needs
to be confirmed before the first release.

Each build uploads an Actions artifact. The publish job refuses to create or
update the GitHub Release unless all six artifact directories contain a payload
and a signing-status record. Release asset names include the platform label,
and `SHA256SUMS.txt` covers every downloadable package and the release notes.

## Signing policy

Signing is never simulated. A stable release fails if any required Windows or
Apple value is absent. A prerelease is allowed to skip platform signing only
when every value for that platform is absent; supplying a partial set fails.
The generated release notes record the result for every target.

Configure these GitHub Actions secrets for Windows Authenticode signing:

- `WINDOWS_CERTIFICATE`: base64-encoded PFX containing the code-signing
  certificate and private key.
- `WINDOWS_CERTIFICATE_PASSWORD`: PFX export password.

Configure the repository Actions variable `WINDOWS_TIMESTAMP_URL` with the RFC
3161 timestamp service supplied by the certificate authority. The workflow
imports the PFX into the ephemeral runner certificate store, passes a temporary
Tauri signing config, and verifies every generated EXE/MSI with
`Get-AuthenticodeSignature`.

Configure these GitHub Actions secrets for macOS Developer ID signing and
notarization:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12`.
- `APPLE_CERTIFICATE_PASSWORD`: `.p12` export password.
- `APPLE_API_ISSUER`: App Store Connect API issuer ID.
- `APPLE_API_KEY`: App Store Connect API key ID.
- `APPLE_API_PRIVATE_KEY`: complete contents of the matching `.p8` private key.

The workflow creates an ephemeral keychain, requires a Developer ID Application
identity, and passes the App Store Connect API key to Tauri. After the build it
uses `codesign`, `stapler`, and `spctl` to verify signing and notarization.

Linux Debian packages are currently not GPG-signed. Their release status says
`not-applicable-unsigned`; users must verify `SHA256SUMS.txt`. Adding Linux
package signatures later requires a separately managed signing key and a
published verification-key policy.

## Validation

Run the static contract check locally without building packages:

```bash
python scripts/validate_release.py --check-workflows
python scripts/validate_release.py --tag v0.1.0-alpha.1 --channel prerelease
```

For a stable release, first update all three project version fields through the
normal application-version change process, run CI, create and push the exact
stable tag, and confirm that all signing credentials are configured. The
workflow itself performs the final version, channel, payload, signature, and
checksum gates.
