#!/usr/bin/env bash

set -euo pipefail

release_notes_en=${1:-release/RELEASE_NOTES.md}
release_notes_zh=${2:-release/RELEASE_NOTES.zh-CN.md}
release_dir=${3:-release}
gh_cli=${GH_CLI:-gh}
tag_verify_script=${TAG_VERIFY_SCRIPT:-.github/scripts/verify-release-tag.sh}

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${VERSION:?VERSION is required}"
: "${PRERELEASE:?PRERELEASE is required}"
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
[[ "${PRERELEASE}" == "true" ]] || {
  echo "Prism publication is prerelease-only; PRERELEASE must be true" >&2
  exit 1
}
[[ -s "${release_notes_en}" ]] || { echo "English release notes are missing: ${release_notes_en}" >&2; exit 1; }
[[ -s "${release_notes_zh}" ]] || { echo "Chinese release notes are missing: ${release_notes_zh}" >&2; exit 1; }

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
python .github/scripts/verify-published-release.py "${verify_args[@]}"

work_dir=$(mktemp -d)
trap 'rm -rf "${work_dir}"' EXIT
release_json="${work_dir}/release.json"
missing_file="${work_dir}/missing.txt"
release_body="$(<"${release_notes_en}")

---

$(<"${release_notes_zh}")"

mapfile -t existing_ids < <("${gh_cli}" api --paginate \
  "repos/${GITHUB_REPOSITORY}/releases?per_page=100" \
  --jq ".[] | select(.tag_name == \"${VERSION}\") | .id")
if (( ${#existing_ids[@]} > 1 )); then
  echo "multiple releases already exist for ${VERSION}" >&2
  exit 1
fi

if (( ${#existing_ids[@]} == 0 )); then
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
else
  release_id=${existing_ids[0]}
fi
[[ "${release_id}" =~ ^[0-9]+$ ]] || { echo "invalid release id: ${release_id}" >&2; exit 1; }

"${gh_cli}" api "repos/${GITHUB_REPOSITORY}/releases/${release_id}" > "${release_json}"
python .github/scripts/verify-resumable-draft.py \
  --release-json "${release_json}" \
  --release-dir "${release_dir}" \
  --notes-en "${release_notes_en}" \
  --notes-zh "${release_notes_zh}" \
  --tag "${VERSION}" \
  --commit "${COMMIT}" \
  --missing-output "${missing_file}"

if [[ -s "${missing_file}" ]]; then
  bash "${tag_verify_script}" "${VERSION}" "${COMMIT}" origin "${EXPECTED_TAG_OBJECT}"
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    "${gh_cli}" release upload "${VERSION}" "${release_dir}/${name}"
  done < "${missing_file}"
fi

"${gh_cli}" api "repos/${GITHUB_REPOSITORY}/releases/${release_id}" > "${release_json}"
python .github/scripts/verify-published-release.py \
  "${verify_args[@]}" \
  --release-json "${release_json}" \
  --expected-state draft

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "release_id=${release_id}" >> "${GITHUB_OUTPUT}"
else
  echo "release_id=${release_id}"
fi
