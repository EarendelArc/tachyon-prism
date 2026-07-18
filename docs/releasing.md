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
as prereleases and explicitly excluded from latest.

The prepare job fetches the remote tag into an isolated ref, verifies the tag
object and peeled commit, and records both full object IDs. Every downstream
test, build, and publish job checks out that same verified commit SHA. Runs for
the same tag share one non-cancelling concurrency group, so two publication
transactions cannot race.

After all assets are prepared, the publication transaction verifies the remote
tag object and peeled commit again. The next external write is the API call that
creates the draft. This narrows the tag-check/create TOCTOU window, but GitHub
does not offer an atomic operation that binds those two actions. Repository tag
rulesets must therefore prohibit release-tag updates and deletions; the final
check is defense in depth, not a replacement for an immutable-tag policy.

## Core compatibility contract

`core-contract.json` pins the paired Tachyon Core repository, release tag, and
full commit. CI and Release check out that exact commit with full tag history;
a missing repository/ref fails the job. The cross-repository test confirms the
checked-out commit has the pinned tag, builds Core with that release version,
generates `client.json` through Prism's production generator, and invokes the
real Core `validate` command. It never copies Core validation rules into Prism.

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

Each build uploads an Actions artifact. The publish job refuses to create the
GitHub Release unless all six artifact directories contain a payload and a
signing-status record. Release asset names include the platform label, and
`SHA256SUMS.txt` covers every downloadable package, release notes, and
`BUILD_METADATA.json`. The metadata records the verified Prism tag object and
commit, `SOURCE_DATE_EPOCH`, pinned Core contract, and tool versions with stable
key ordering. Before upload, Prism normalizes the staged files and directories
to `SOURCE_DATE_EPOCH` without rewriting package contents.

This is best-effort timestamp normalization, not a claim that installers are
byte-for-byte reproducible. Authenticode timestamps, Apple signing and
notarization, and installer/package tool internals may still vary between runs.

Publication is fail-on-existing: any GitHub Release with the same tag, including
a draft, stops the workflow. The workflow creates a new draft, uploads the full
asset set exactly once without `--clobber`, then publishes that draft. It never
edits or replaces an existing official release. An EXIT trap handles upload or
publish failures by querying only the numeric release ID returned by this
transaction. It deletes that ID only when the API still reports the same tag and
`draft=true`; a release that has become official is never deleted by cleanup.

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
