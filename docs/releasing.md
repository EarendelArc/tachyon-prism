# Prism Release Process

## Channels and tags

The immutable publication workflow accepts only these existing prerelease Git tags:

- `vMAJOR.MINOR.PATCH-(alpha|beta|rc|pre|preview)[.N]`, for example
  `v0.1.0-alpha.1` or `v0.1.0-rc.2`.

The version before the suffix must match `package.json`,
`src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. Tag pushes derive the
channel from the tag. A manual dispatch requires an existing prerelease tag;
stable tags and `prerelease=false` fail before publication. Manual runs check out
the tag itself, not the branch from which the workflow was started.

Published builds are always marked as prereleases and excluded from Latest.

Release tags must be signed annotated Git tag objects; lightweight and unsigned
annotated tags fail validation.
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

`core-contract.json` pins the paired `EarendelArc/tachyon-core` repository, annotated release
tag, full tag-object ID, and peeled commit. The current pin is
`v0.1.0-alpha.22`, tag object
`65f57643ae5644233033c3a3a7332290ff1ceeb6`, peeled commit
`80d9fb742c025387c1f036da846fc663ed8a7067`. CI and Release check out that exact
commit with full tag history and verify the annotated tag peel; a missing or
changed repository/ref fails the job.

The explicit cross-repository job runs on Linux, macOS, and Windows. It builds
Core from the pinned source, generates `client.json` through Prism's production
generator, invokes the real validator, and fault-injects `not-a-cidr` to require
Core to reject `client.tun.game_routes[0]`. Linux/macOS run the valid non-empty
route config and require failure before TUN readiness. Windows executes only
the pinned source's named route simulations and parses `go test -json` to prove
every test actually ran. It never copies Core validation rules into Prism and
never opts into real-route or TUN integration tests.

The Windows proof requires exactly one `run` and one `pass`, with no `fail` or
`skip`, for each of these tests:

- `TestParseGameRoutePrefixesNormalizesHostBits`
- `TestPlanSelectiveRoutesNormalizesAndDeduplicates`
- `TestWindowsRouteRowsRequireExactIdentityAndAttributes`
- `TestInstallRouteTransactionRollsBackInReverseOrder`
- `TestWindowsRouteJournalRecordFailureRollsBackCreatedRouteUnderLock`

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
the final release must contain exactly 13 assets: seven installers, English and
Chinese release notes, `BUILD_METADATA.json`, `RELEASE_INDEX.json`,
`RELEASE_MANIFEST.json`, and `SHA256SUMS.txt`. `SHA256SUMS.txt` contains exactly
12 entries and covers every other asset.
The schema-versioned metadata records the verified full Prism tag object and
commit, `SOURCE_DATE_EPOCH`, the exact Core tag object and peeled commit, tool
versions, and a deterministic SHA-256 map for all seven installers. Before
upload, Prism normalizes staged file and directory timestamps to
`SOURCE_DATE_EPOCH` without rewriting package contents.

This is best-effort timestamp normalization, not a claim that installers are
byte-for-byte reproducible. Authenticode timestamps, Apple signing and
notarization, and installer/package tool internals may still vary between runs.

Publication is a re-entrant four-job transaction. Job A performs the immutable
release and ruleset preflight with only `RELEASE_SETTINGS_TOKEN`. Job B uses only
the contents-write `GITHUB_TOKEN` to create or resume an exact draft and upload
only missing assets without `--clobber`. Job C repeats the governance check with
only the settings token. Job D uses only the contents-write token to verify the
complete draft, publish it, and verify the immutable readback. The settings and
contents-write credentials never share a step or process environment.

An existing same-tag draft is resumable only when its numeric ID, full target
commit, name, prerelease flag, bilingual body, and every existing asset digest
and size match the local transaction. Extra, duplicate, or mutated assets and a
different target fail closed. Upload or second-governance failures leave the
draft private and intact for a workflow rerun; no release cleanup or deletion is
performed. An existing public release is never edited or replaced.

The GitHub Release body is the complete English note followed by the complete
Chinese note. After publication, the transaction reads the release back through
the API and fails closed unless the tag, full target commit, draft/prerelease
flags, immutable state, latest-release semantics, bilingual body, exact asset
set, and every remote asset digest and size match the staged contract. Repositories must
enable GitHub immutable releases and an active `refs/tags/v*` ruleset that
prevents tag update, deletion, and non-fast-forward changes, plus an active
zero-bypass `main` ruleset requiring pull requests and strict `Required CI gate`, before dispatching
the release workflow.

The governance-only jobs independently enforce repository policy before the
first write and immediately before publication. They read the immutable-release
setting, paginate repository ruleset summaries, then read each candidate ruleset's full shape. Publication
continues only when at least one active tag ruleset includes `refs/tags/v*`, has
no bypass actors, and contains deletion, update, and non-fast-forward rules.
Missing pages, malformed JSON, permission errors, and API failures are all
fail-closed. The GitHub Latest readback follows the same rule: only an explicit
HTTP 404 means no Latest release exists; authentication, authorization, network,
and server failures stop the job.

`BUILD_METADATA.json` is validated as an exact schema, not as a collection of
optional hints. The verified tag object, commit timestamp, tag verification
method, reproducibility declaration, and complete tool-version object are passed
explicitly from the prepare job and must match exactly both before upload and
during final release readback.

Store a fine-grained token as the repository Actions secret
`RELEASE_SETTINGS_TOKEN`. It must be able to read the repository immutable
release setting and the full ruleset shape, including `bypass_actors`. GitHub
may suppress bypass actors unless the credential has ruleset write access, even
though Prism performs GET requests only. Keep this
credential separate from the ordinary release `GITHUB_TOKEN`. The workflow has
top-level `contents: read`; only the draft and publication jobs receive
job-scoped `contents: write`. The settings token appears only in governance-step
environments, while the write token appears only in draft/publication steps.

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
