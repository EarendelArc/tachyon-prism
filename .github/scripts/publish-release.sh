#!/usr/bin/env bash

set -euo pipefail

release_notes_en=${1:-release/RELEASE_NOTES.md}
release_notes_zh=${2:-release/RELEASE_NOTES.zh-CN.md}
release_dir=${3:-release}
gh_cli=${GH_CLI:-gh}
tag_verify_script=${TAG_VERIFY_SCRIPT:-.github/scripts/verify-release-tag.sh}

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${VERSION:?VERSION is required}"
: "${PRERELEASE:?PRERELEASE is required}"
: "${COMMIT:?COMMIT is required}"
: "${EXPECTED_TAG_OBJECT:?EXPECTED_TAG_OBJECT is required}"

[[ "${PRERELEASE}" == "true" || "${PRERELEASE}" == "false" ]] || {
  echo "PRERELEASE must be true or false" >&2
  exit 1
}
[[ -s "${release_notes_en}" ]] || { echo "English release notes are missing: ${release_notes_en}" >&2; exit 1; }
[[ -s "${release_notes_zh}" ]] || { echo "Chinese release notes are missing: ${release_notes_zh}" >&2; exit 1; }
[[ -d "${release_dir}" ]] || { echo "release asset directory is missing: ${release_dir}" >&2; exit 1; }

python .github/scripts/verify-published-release.py \
  --release-dir "${release_dir}" \
  --tag "${VERSION}" \
  --commit "${COMMIT}"

release_body="$(<"${release_notes_en}")

---

$(<"${release_notes_zh}")"

release_id=""
readback_file=""

cleanup_failed_draft() {
  local status=$1
  local release_state current_id current_draft current_tag
  trap - EXIT
  if [[ -n "${readback_file}" ]]; then
    rm -f "${readback_file}"
  fi

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

# Keep the final remote tag check immediately adjacent to the first release write.
bash "${tag_verify_script}" "${VERSION}" "${COMMIT}" origin "${EXPECTED_TAG_OBJECT}"
release_id=$("${gh_cli}" api --method POST \
  "repos/${GITHUB_REPOSITORY}/releases" \
  -f tag_name="${VERSION}" \
  -f target_commitish="${COMMIT}" \
  -f name="Tachyon Prism ${VERSION}" \
  -f body="${release_body}" \
  -F draft=true \
  -F prerelease="${PRERELEASE}" \
  --jq '.id')
[[ "${release_id}" =~ ^[0-9]+$ ]] || {
  echo "draft create returned an invalid release id: ${release_id}" >&2
  exit 1
}

"${gh_cli}" release upload "${VERSION}" "${release_dir}"/*

if [[ "${PRERELEASE}" == "true" ]]; then
  make_latest="false"
else
  make_latest="true"
fi
"${gh_cli}" api --method PATCH \
  "repos/${GITHUB_REPOSITORY}/releases/${release_id}" \
  -F draft=false \
  -F prerelease="${PRERELEASE}" \
  -f make_latest="${make_latest}" >/dev/null

readback_file=$(mktemp)
"${gh_cli}" api "repos/${GITHUB_REPOSITORY}/releases/${release_id}" > "${readback_file}"
if latest_tag=$("${gh_cli}" api \
  "repos/${GITHUB_REPOSITORY}/releases/latest" \
  --jq '.tag_name' 2>/dev/null); then
  :
else
  latest_tag="__NONE__"
fi
python .github/scripts/verify-published-release.py \
  --release-dir "${release_dir}" \
  --tag "${VERSION}" \
  --commit "${COMMIT}" \
  --release-json "${readback_file}" \
  --prerelease "${PRERELEASE}" \
  --latest-tag "${latest_tag}"

release_id=""
rm -f "${readback_file}"
readback_file=""
