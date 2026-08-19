#!/usr/bin/env bash
set -Eeuo pipefail

if (( $# == 0 )); then
  echo "usage: $0 PACKAGE..." >&2
  exit 2
fi

readonly max_attempts=3
readonly command_timeout_seconds=75
readonly -a apt_options=(
  -o Acquire::Retries=2
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
  -o DPkg::Lock::Timeout=30
  -o Dpkg::Use-Pty=0
)

apt_diagnostics() {
  echo "::group::APT mirror diagnostics"
  if [[ -r /etc/os-release ]]; then
    grep -E '^(ID|VERSION_ID|VERSION_CODENAME)=' /etc/os-release || true
  fi
  python3 - <<'PY'
from pathlib import Path
from urllib.parse import urlsplit
import re

paths = [Path("/etc/apt/sources.list")]
paths.extend(sorted(Path("/etc/apt/sources.list.d").glob("*")))
hosts = set()
for path in paths:
    if not path.is_file():
        continue
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        continue
    for url in re.findall(r"https?://[^\s\]]+", text):
        host = urlsplit(url).hostname
        if host:
            hosts.add(host)
print("Configured mirror hosts: " + (", ".join(sorted(hosts)) or "none"))
PY
  ps -eo pid,etimes,stat,comm,args | grep -E '[a]pt|[d]pkg' || true
  df -h / || true
  echo "::endgroup::"
}

for attempt in $(seq 1 "${max_attempts}"); do
  echo "APT install attempt ${attempt}/${max_attempts}"
  if sudo -n env DEBIAN_FRONTEND=noninteractive \
      timeout --signal=TERM --kill-after=15s "${command_timeout_seconds}s" \
      apt-get "${apt_options[@]}" update \
    && sudo -n env DEBIAN_FRONTEND=noninteractive \
      timeout --signal=TERM --kill-after=15s "${command_timeout_seconds}s" \
      apt-get "${apt_options[@]}" install -y -- "$@"; then
    exit 0
  fi

  apt_diagnostics
  if (( attempt < max_attempts )); then
    sleep $((attempt * 10))
  fi
done

echo "APT dependency installation failed after ${max_attempts} bounded attempts" >&2
exit 1
