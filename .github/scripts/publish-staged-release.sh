#!/usr/bin/env bash

set -euo pipefail

release_dir=${1:-release}
gh_cli=${GH_CLI:-gh}
tag_verify_script=${TAG_VERIFY_SCRIPT:-.github/scripts/verify-release-tag.sh}
latest_response_parser=${LATEST_RESPONSE_PARSER:-.github/scripts/parse-latest-release-response.py}

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${VERSION:?VERSION is required}"
: "${COMMIT:?COMMIT is required}"
: "${EXPECTED_TAG_OBJECT:?EXPECTED_TAG_OBJECT is required}"
: "${EXPECTED_SOURCE_DATE_EPOCH:?EXPECTED_SOURCE_DATE_EPOCH is required}"
: "${EXPECTED_TAG_VERIFICATION:?EXPECTED_TAG_VERIFICATION is required}"
: "${EXPECTED_REPRODUCIBILITY_JSON:?EXPECTED_REPRODUCIBILITY_JSON is required}"
: "${EXPECTED_TOOLS_JSON:?EXPECTED_TOOLS_JSON is required}"

[[ -z "${RELEASE_SETTINGS_TOKEN:-}" ]] || {
  echo "RELEASE_SETTINGS_TOKEN must not be present in the contents-write process" >&2
  exit 1
}
[[ "${RELEASE_ID}" =~ ^[0-9]+$ ]] || { echo "invalid RELEASE_ID: ${RELEASE_ID}" >&2; exit 1; }

verify_args=(
  --release-dir "${release_dir}"
  --tag "${VERSION}"
  --commit "${COMMIT}"
  --expected-tag-object "${EXPECTED_TAG_OBJECT}"
  --expected-source-date-epoch "${EXPECTED_SOURCE_DATE_EPOCH}"
  --expected-tag-verification "${EXPECTED_TAG_VERIFICATION}"
  --expected-reproducibility-json "${EXPECTED_REPRODUCIBILITY_JSON}"
  --expected-tools-json "${EXPECTED_TOOLS_JSON}"
)
work_dir=$(mktemp -d)
trap 'rm -rf "${work_dir}"' EXIT
readback_file="${work_dir}/release.json"
latest_response_file="${work_dir}/latest-response.txt"
latest_error_file="${work_dir}/latest-error.txt"

"${gh_cli}" api "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}" > "${readback_file}"
python .github/scripts/verify-published-release.py \
  "${verify_args[@]}" \
  --release-json "${readback_file}" \
  --expected-state draft
bash "${tag_verify_script}" "${VERSION}" "${COMMIT}" origin "${EXPECTED_TAG_OBJECT}"

"${gh_cli}" api --method PATCH \
  "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}" \
  -F draft=false \
  -F prerelease=true \
  -f make_latest=false >/dev/null

"${gh_cli}" api "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}" > "${readback_file}"
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
  "${verify_args[@]}" \
  --release-json "${readback_file}" \
  --expected-state published \
  --latest-tag "${latest_tag}"
