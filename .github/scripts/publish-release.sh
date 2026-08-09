#!/usr/bin/env bash

set -euo pipefail

release_notes_en=${1:-release/RELEASE_NOTES.md}
release_notes_zh=${2:-release/RELEASE_NOTES.zh-CN.md}
release_dir=${3:-release}
gh_cli=${GH_CLI:-gh}
tag_verify_script=${TAG_VERIFY_SCRIPT:-.github/scripts/verify-release-tag.sh}
governance_verify_script=${GOVERNANCE_VERIFY_SCRIPT:-.github/scripts/verify-release-governance.py}
latest_response_parser=${LATEST_RESPONSE_PARSER:-.github/scripts/parse-latest-release-response.py}
github_api_version=${GITHUB_API_VERSION:-2026-03-10}

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${VERSION:?VERSION is required}"
: "${PRERELEASE:?PRERELEASE is required}"
: "${COMMIT:?COMMIT is required}"
: "${EXPECTED_TAG_OBJECT:?EXPECTED_TAG_OBJECT is required}"
: "${EXPECTED_SOURCE_DATE_EPOCH:?EXPECTED_SOURCE_DATE_EPOCH is required}"
: "${EXPECTED_TAG_VERIFICATION:?EXPECTED_TAG_VERIFICATION is required}"
: "${EXPECTED_REPRODUCIBILITY_JSON:?EXPECTED_REPRODUCIBILITY_JSON is required}"
: "${EXPECTED_TOOLS_JSON:?EXPECTED_TOOLS_JSON is required}"
: "${RELEASE_SETTINGS_TOKEN:?RELEASE_SETTINGS_TOKEN with read access to immutable settings and full ruleset details is required}"

[[ "${PRERELEASE}" == "true" ]] || {
  echo "Prism publication is prerelease-only; PRERELEASE must be true" >&2
  exit 1
}
[[ -s "${release_notes_en}" ]] || { echo "English release notes are missing: ${release_notes_en}" >&2; exit 1; }
[[ -s "${release_notes_zh}" ]] || { echo "Chinese release notes are missing: ${release_notes_zh}" >&2; exit 1; }
[[ -d "${release_dir}" ]] || { echo "release asset directory is missing: ${release_dir}" >&2; exit 1; }

python .github/scripts/verify-published-release.py \
  --release-dir "${release_dir}" \
  --tag "${VERSION}" \
  --commit "${COMMIT}" \
  --expected-tag-object "${EXPECTED_TAG_OBJECT}" \
  --expected-source-date-epoch "${EXPECTED_SOURCE_DATE_EPOCH}" \
  --expected-tag-verification "${EXPECTED_TAG_VERIFICATION}" \
  --expected-reproducibility-json "${EXPECTED_REPRODUCIBILITY_JSON}" \
  --expected-tools-json "${EXPECTED_TOOLS_JSON}"

release_body="$(<"${release_notes_en}")

---

$(<"${release_notes_zh}")"

release_id=""
readback_file=""
governance_dir=""
latest_response_file=""
latest_error_file=""

cleanup_temp_files() {
  if [[ -n "${readback_file}" ]]; then
    rm -f "${readback_file}"
  fi
  if [[ -n "${latest_response_file}" ]]; then
    rm -f "${latest_response_file}"
  fi
  if [[ -n "${latest_error_file}" ]]; then
    rm -f "${latest_error_file}"
  fi
  if [[ -n "${governance_dir}" ]]; then
    rm -rf "${governance_dir}"
  fi
}

cleanup_failed_draft() {
  local status=$1
  local release_state current_id current_draft current_tag
  trap - EXIT
  cleanup_temp_files

  if [[ ${status} -eq 0 || -z "${release_id}" ]]; then
    exit "${status}"
  fi

  if ! release_state=$("${gh_cli}" api \
    "repos/${GITHUB_REPOSITORY}/releases/${release_id}" \
    --jq '[.id, .draft, .tag_name] | @tsv' 2>/dev/null); then
    echo "warning: could not inspect failed release id ${release_id}; no release was deleted" >&2
    exit "${status}"
  fi
  IFS=$'\t' read -r current_id current_draft current_tag <<< "${release_state}"
  if [[ "${current_id}" != "${release_id}" || "${current_draft}" != "true" || "${current_tag}" != "${VERSION}" ]]; then
    echo "warning: release id ${release_id} is not this transaction's draft; refusing deletion" >&2
    exit "${status}"
  fi

  if "${gh_cli}" api --method DELETE \
    "repos/${GITHUB_REPOSITORY}/releases/${release_id}" >/dev/null; then
    echo "cleaned failed draft release ${VERSION} (id ${release_id})" >&2
  else
    echo "warning: failed to clean draft release ${VERSION} (id ${release_id})" >&2
  fi
  exit "${status}"
}

trap 'cleanup_failed_draft $?' EXIT

existing_id=$("${gh_cli}" api --paginate \
  "repos/${GITHUB_REPOSITORY}/releases?per_page=100" \
  --jq ".[] | select(.tag_name == \"${VERSION}\") | .id" | head -n 1)
[[ -z "${existing_id}" ]] || {
  echo "release ${VERSION} already exists as id ${existing_id}; refusing to edit or replace assets" >&2
  exit 1
}

# Governance is deliberately checked immediately before the final tag check and
# the first write. API failures, incomplete pagination, and malformed responses
# all stop publication.
governance_dir=$(mktemp -d)
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
mapfile -t ruleset_ids < "${ruleset_ids_file}"
governance_args=(--immutable-json "${immutable_json}")
for ruleset_id in "${ruleset_ids[@]}"; do
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
done
python "${governance_verify_script}" "${governance_args[@]}"

# Keep the final remote tag check immediately adjacent to the first release write.
bash "${tag_verify_script}" "${VERSION}" "${COMMIT}" origin "${EXPECTED_TAG_OBJECT}"
release_id=$("${gh_cli}" api --method POST \
  "repos/${GITHUB_REPOSITORY}/releases" \
  -f tag_name="${VERSION}" \
  -f target_commitish="${COMMIT}" \
  -f name="Tachyon Prism ${VERSION}" \
  -f body="${release_body}" \
  -F draft=true \
  -F prerelease=true \
  --jq '.id')
[[ "${release_id}" =~ ^[0-9]+$ ]] || {
  echo "draft create returned an invalid release id: ${release_id}" >&2
  exit 1
}

"${gh_cli}" release upload "${VERSION}" "${release_dir}"/*

"${gh_cli}" api --method PATCH \
  "repos/${GITHUB_REPOSITORY}/releases/${release_id}" \
  -F draft=false \
  -F prerelease=true \
  -f make_latest=false >/dev/null

readback_file=$(mktemp)
"${gh_cli}" api "repos/${GITHUB_REPOSITORY}/releases/${release_id}" > "${readback_file}"
latest_response_file=$(mktemp)
latest_error_file=$(mktemp)
set +e
"${gh_cli}" api --include \
  "repos/${GITHUB_REPOSITORY}/releases/latest" \
  > "${latest_response_file}" 2> "${latest_error_file}"
latest_command_status=$?
set -e
if ! latest_tag=$(python "${latest_response_parser}" \
  --response "${latest_response_file}" \
  --command-status "${latest_command_status}"); then
  cat "${latest_error_file}" >&2
  exit 1
fi
python .github/scripts/verify-published-release.py \
  --release-dir "${release_dir}" \
  --tag "${VERSION}" \
  --commit "${COMMIT}" \
  --expected-tag-object "${EXPECTED_TAG_OBJECT}" \
  --expected-source-date-epoch "${EXPECTED_SOURCE_DATE_EPOCH}" \
  --expected-tag-verification "${EXPECTED_TAG_VERIFICATION}" \
  --expected-reproducibility-json "${EXPECTED_REPRODUCIBILITY_JSON}" \
  --expected-tools-json "${EXPECTED_TOOLS_JSON}" \
  --release-json "${readback_file}" \
  --latest-tag "${latest_tag}"

release_id=""
cleanup_temp_files
readback_file=""
governance_dir=""
latest_response_file=""
latest_error_file=""
