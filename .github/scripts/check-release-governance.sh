#!/usr/bin/env bash

set -euo pipefail

gh_cli=${GH_CLI:-gh}
github_api_version=${GITHUB_API_VERSION:-2026-03-10}
governance_verify_script=${GOVERNANCE_VERIFY_SCRIPT:-.github/scripts/verify-release-governance.py}

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RELEASE_SETTINGS_TOKEN:?RELEASE_SETTINGS_TOKEN is required}"

[[ -z "${GH_TOKEN:-}" ]] || {
  echo "GH_TOKEN must not be present in the governance-only process" >&2
  exit 1
}

governance_dir=$(mktemp -d)
trap 'rm -rf "${governance_dir}"' EXIT
immutable_json="${governance_dir}/immutable.json"
ruleset_ids_file="${governance_dir}/ruleset-ids.txt"

GH_TOKEN="${RELEASE_SETTINGS_TOKEN}" "${gh_cli}" api \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: ${github_api_version}" \
  "repos/${GITHUB_REPOSITORY}/immutable-releases" > "${immutable_json}"
GH_TOKEN="${RELEASE_SETTINGS_TOKEN}" "${gh_cli}" api --paginate \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: ${github_api_version}" \
  "repos/${GITHUB_REPOSITORY}/rulesets?includes_parents=false&per_page=100" \
  --jq '.[] | .id' > "${ruleset_ids_file}"

governance_args=(--immutable-json "${immutable_json}")
while IFS= read -r ruleset_id; do
  [[ "${ruleset_id}" =~ ^[0-9]+$ ]] || {
    echo "repository ruleset list returned an invalid id: ${ruleset_id}" >&2
    exit 1
  }
  ruleset_json="${governance_dir}/ruleset-${ruleset_id}.json"
  GH_TOKEN="${RELEASE_SETTINGS_TOKEN}" "${gh_cli}" api \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: ${github_api_version}" \
    "repos/${GITHUB_REPOSITORY}/rulesets/${ruleset_id}" > "${ruleset_json}"
  governance_args+=(--ruleset-json "${ruleset_json}")
done < "${ruleset_ids_file}"

python "${governance_verify_script}" "${governance_args[@]}"
