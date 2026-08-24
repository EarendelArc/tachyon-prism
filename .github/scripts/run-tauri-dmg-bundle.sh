#!/usr/bin/env bash
set -uo pipefail

target="${1:?usage: run-tauri-dmg-bundle.sh <rust-target>}"
workspace="${GITHUB_WORKSPACE:-$(pwd)}"
diagnostics="${workspace}/artifacts/ci-dmg-diagnostics/${target}"
wrappers="${RUNNER_TEMP:-/tmp}/tachyon-prism-dmg-tool-wrappers"
bundle_root="${workspace}/src-tauri/target/${target}/release/bundle/dmg"

rm -rf "${diagnostics}" "${wrappers}"
mkdir -p "${diagnostics}/generated" "${wrappers}"

export TAURI_DMG_HDIUTIL="$(command -v hdiutil)"
export TAURI_DMG_OSASCRIPT="$(command -v osascript)"
export TAURI_DMG_DIAGNOSTICS="${diagnostics}"
export TAURI_DMG_TOOL_TRACE="${diagnostics}/tool-trace.log"
export TAURI_DMG_SHELL_TRACE="${diagnostics}/shell-trace.log"

cat > "${wrappers}/hdiutil" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
printf '[%s] hdiutil' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "${TAURI_DMG_TOOL_TRACE}"
printf ' %q' "$@" >> "${TAURI_DMG_TOOL_TRACE}"
printf '\n' >> "${TAURI_DMG_TOOL_TRACE}"
set +e
"${TAURI_DMG_HDIUTIL}" "$@" \
  > >(tee -a "${TAURI_DMG_DIAGNOSTICS}/hdiutil.stdout.log") \
  2> >(tee -a "${TAURI_DMG_DIAGNOSTICS}/hdiutil.stderr.log" >&2)
status=$?
set -e
printf '[%s] hdiutil exit=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${status}" >> "${TAURI_DMG_TOOL_TRACE}"
exit "${status}"
EOF

cat > "${wrappers}/osascript" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
printf '[%s] osascript' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "${TAURI_DMG_TOOL_TRACE}"
printf ' %q' "$@" >> "${TAURI_DMG_TOOL_TRACE}"
printf '\n' >> "${TAURI_DMG_TOOL_TRACE}"
set +e
"${TAURI_DMG_OSASCRIPT}" "$@" \
  > >(tee -a "${TAURI_DMG_DIAGNOSTICS}/osascript.stdout.log") \
  2> >(tee -a "${TAURI_DMG_DIAGNOSTICS}/osascript.stderr.log" >&2)
status=$?
set -e
printf '[%s] osascript exit=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${status}" >> "${TAURI_DMG_TOOL_TRACE}"
exit "${status}"
EOF

chmod 700 "${wrappers}/hdiutil" "${wrappers}/osascript"
export PATH="${wrappers}:${PATH}"

trace_init="${wrappers}/bash-env"
cat > "${trace_init}" <<'EOF'
if [[ -n "${TAURI_DMG_SHELL_TRACE:-}" ]]; then
  exec 19>>"${TAURI_DMG_SHELL_TRACE}"
  export BASH_XTRACEFD=19
  export PS4='+ ${BASH_SOURCE##*/}:${LINENO}: '
  set -x
fi
EOF
export BASH_ENV="${trace_init}"

set +e
npm run build -- --target "${target}" --bundles dmg \
  > >(tee "${diagnostics}/tauri-build.stdout.log") \
  2> >(tee "${diagnostics}/tauri-build.stderr.log" >&2)
status=$?
set -e

printf 'target=%s\nexit=%s\nbundleRoot=%s\n' \
  "${target}" "${status}" "${bundle_root}" > "${diagnostics}/RESULT.txt"

if [[ "${status}" -ne 0 ]]; then
  if [[ -d "${bundle_root}" ]]; then
    find "${bundle_root}" -maxdepth 4 -type f -print | sort \
      > "${diagnostics}/generated-files.txt" 2>&1 || true
    find "${bundle_root}" -maxdepth 4 -type f -name 'bundle_dmg.sh' -print \
      > "${diagnostics}/bundle-dmg-script-paths.txt" 2>&1 || true
    while IFS= read -r generated; do
      cp -p "${generated}" "${diagnostics}/generated/$(basename "${generated}")" || true
    done < <(find "${bundle_root}" -maxdepth 4 -type f \
      \( -name '*.sh' -o -name '*.applescript' -o -name '*.log' \) -print)
    du -ah "${bundle_root}" > "${diagnostics}/bundle-disk-usage.txt" 2>&1 || true
  fi
  "${TAURI_DMG_HDIUTIL}" info > "${diagnostics}/hdiutil-info.log" 2>&1 || true
  ps aux > "${diagnostics}/processes.log" 2>&1 || true
  df -h > "${diagnostics}/disk-free.log" 2>&1 || true
  mount > "${diagnostics}/mounts.log" 2>&1 || true
  log show --last 20m --style compact \
    --predicate 'process == "hdiutil" OR process == "osascript" OR process == "diskimages-helper" OR process == "diskimages-help"' \
    > "${diagnostics}/macos-disk-image-system.log" 2>&1 || true
fi

exit "${status}"
