#!/usr/bin/env python3
"""Build deterministic Tachyon Prism prerelease metadata and release notes."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import tempfile
from pathlib import Path


REPOSITORY = "EarendelArc/tachyon-prism"
PREVIEW_TAG = re.compile(
    r"^v\d+\.\d+\.\d+-(?:alpha|beta|rc|pre|preview)(?:[.-][0-9A-Za-z]+)*$"
)
TARGETS = {
    "windows-x64": ("windows", "x86_64", (".exe", ".msi")),
    "windows-arm64": ("windows", "aarch64", (".exe",)),
    "macos-x64": ("macos", "x86_64", (".dmg",)),
    "macos-arm64": ("macos", "aarch64", (".dmg",)),
    "linux-x64": ("linux", "x86_64", (".deb",)),
    "linux-arm64": ("linux", "aarch64", (".deb",)),
}
AUXILIARY_NAMES = (
    "BUILD_METADATA.json",
    "RELEASE_INDEX.json",
    "RELEASE_MANIFEST.json",
    "RELEASE_NOTES.md",
    "RELEASE_NOTES.zh-CN.md",
    "SHA256SUMS.txt",
)


def fail(message: str) -> None:
    raise ValueError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_text(path: Path, contents: str) -> None:
    path.write_text(contents, encoding="utf-8", newline="\n")


def write_json(path: Path, value: object) -> None:
    write_text(path, json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def load_object(path: Path, description: str) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"{description} must be a JSON object")
    return value


def load_tools(path: Path) -> dict[str, str]:
    tools: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        parts = line.split(maxsplit=1)
        if len(parts) != 2 or parts[0] in tools:
            fail(f"invalid tool version line: {line!r}")
        tools[parts[0]] = parts[1]
    if not tools:
        fail("tool version contract is empty")
    return dict(sorted(tools.items()))


def installer_records(release_dir: Path) -> list[dict[str, object]]:
    files = sorted(path for path in release_dir.iterdir() if path.is_file())
    unexpected_aux = [path.name for path in files if path.name in AUXILIARY_NAMES]
    if unexpected_aux:
        fail(f"release metadata already exists before preparation: {unexpected_aux}")
    records: list[dict[str, object]] = []
    matched_names: set[str] = set()
    for target, (platform, arch, suffixes) in TARGETS.items():
        prefix = f"tachyon-prism-{target}_"
        matched = [path for path in files if path.name.startswith(prefix)]
        actual_suffixes = tuple(sorted(path.suffix.lower() for path in matched))
        if actual_suffixes != tuple(sorted(suffixes)) or len(matched) != len(suffixes):
            fail(
                f"installer layout for {target} must be {sorted(suffixes)}, "
                f"found {[path.name for path in matched]}"
            )
        for path in matched:
            matched_names.add(path.name)
            records.append(
                {
                    "arch": arch,
                    "format": path.suffix.lower().lstrip("."),
                    "name": path.name,
                    "platform": platform,
                    "sha256": f"sha256:{sha256(path)}",
                    "size": path.stat().st_size,
                    "target": target,
                }
            )
    all_names = {path.name for path in files}
    if all_names != matched_names or len(records) != 7:
        fail(f"release directory must contain exactly 7 installers, found {sorted(all_names)}")
    return sorted(records, key=lambda value: str(value["name"]))


def signing_statuses(artifacts_dir: Path) -> dict[str, str]:
    statuses: dict[str, str] = {}
    for target in TARGETS:
        path = artifacts_dir / f"tachyon-prism-{target}" / "release-status" / f"{target}.txt"
        if not path.is_file():
            fail(f"missing signing status for {target}")
        value = path.read_text(encoding="utf-8").strip()
        if value not in {
            "authenticode-signed",
            "signed-and-notarized",
            "not-applicable-unsigned",
            "unsigned-no-credentials",
        }:
            fail(f"invalid signing status for {target}: {value!r}")
        statuses[target] = value
    return statuses


def release_notes(
    *, tag: str, commit: str, core: dict[str, object], installers: list[dict[str, object]],
    statuses: dict[str, str], language: str
) -> str:
    names = [str(item["name"]) for item in installers]
    if language == "en":
        lines = [
            f"# Tachyon Prism {tag}", "", "Channel: preview", f"Prism commit: {commit}",
            f"Compatible Tachyon Core: {core['tag']} ({core['commit']})", "",
            "This is an immutable Tachyon Prism desktop prerelease.",
            "It is not a stable or complete release.", "", "Prerelease limitations:",
            "- System proxy and TUN require isolated-environment validation before general use.",
            "- Real VPS, real client, and real game UDP acceleration still require field testing.",
            "", "## Signing status",
        ]
        lines.extend(f"- {target}: {statuses[target]}" for target in TARGETS)
        lines.extend(["", "Linux packages are not GPG-signed; verify every download with SHA256SUMS.txt.", "", "## Installers"])
        lines.extend(f"- {name}" for name in names)
        lines.extend(["", "Verify the exact asset set, sizes, and digests with RELEASE_MANIFEST.json and SHA256SUMS.txt."])
    else:
        lines = [
            f"# Tachyon Prism {tag}", "", "通道：preview", f"Prism 提交：{commit}",
            f"兼容 Tachyon Core：{core['tag']} ({core['commit']})", "",
            "这是不可变的 Tachyon Prism 桌面端预发布版本。",
            "当前版本尚未达到稳定或完整状态。", "", "预发布限制：",
            "- 系统代理和 TUN 在面向普通用户启用前仍需完成隔离环境验收。",
            "- 真实 VPS、真实客户端和真实游戏 UDP 加速仍需现场测试。",
            "", "## 签名状态",
        ]
        lines.extend(f"- {target}: {statuses[target]}" for target in TARGETS)
        lines.extend(["", "Linux 软件包当前没有 GPG 签名；请使用 SHA256SUMS.txt 校验每个下载文件。", "", "## 安装包"])
        lines.extend(f"- {name}" for name in names)
        lines.extend(["", "请使用 RELEASE_MANIFEST.json 与 SHA256SUMS.txt 核对完整资产集合、大小和摘要。"])
    return "\n".join(lines) + "\n"


def classify_asset(name: str, installers: list[dict[str, object]]) -> dict[str, object]:
    installer = next((item for item in installers if item["name"] == name), None)
    if installer is not None:
        return {
            "arch": installer["arch"],
            "format": installer["format"],
            "kind": "installer",
            "name": name,
            "platform": installer["platform"],
            "sha256": installer["sha256"],
            "size": installer["size"],
            "target": installer["target"],
        }
    return {"kind": "metadata", "name": name}


def prepare(
    *, release_dir: Path, artifacts_dir: Path, tag: str, commit: str, tag_object: str,
    source_date_epoch: int, core_contract_path: Path, tool_versions_path: Path
) -> None:
    if not PREVIEW_TAG.fullmatch(tag):
        fail("Prism immutable publication accepts preview tags only")
    if not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", commit):
        fail("commit must be a full lowercase Git object ID")
    if not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", tag_object):
        fail("tag object must be a full lowercase Git object ID")
    if source_date_epoch <= 0:
        fail("source date epoch must be positive")
    if not release_dir.is_dir():
        fail(f"release directory is missing: {release_dir}")

    for name in AUXILIARY_NAMES:
        (release_dir / name).unlink(missing_ok=True)
    installers = installer_records(release_dir)
    statuses = signing_statuses(artifacts_dir)
    core = load_object(core_contract_path, "Core contract")
    tools = load_tools(tool_versions_path)
    write_text(
        release_dir / "RELEASE_NOTES.md",
        release_notes(tag=tag, commit=commit, core=core, installers=installers, statuses=statuses, language="en"),
    )
    write_text(
        release_dir / "RELEASE_NOTES.zh-CN.md",
        release_notes(tag=tag, commit=commit, core=core, installers=installers, statuses=statuses, language="zh"),
    )

    metadata = {
        "artifactDigests": {str(item["name"]): item["sha256"] for item in installers},
        "coreContract": core,
        "prism": {
            "channel": "preview",
            "commit": commit,
            "prerelease": True,
            "sourceDateEpoch": source_date_epoch,
            "tag": tag,
            "tagObject": tag_object,
            "tagVerification": "signature",
        },
        "reproducibility": {
            "installerByteReproducibilityGuaranteed": False,
            "stagedAssetTimestampsNormalized": True,
        },
        "schemaVersion": 2,
        "tools": tools,
    }
    write_json(release_dir / "BUILD_METADATA.json", metadata)

    index = {
        "channels": {
            "preview": {"acceptsPrerelease": True, "prefersPrerelease": True},
            "stable": {"acceptsPrerelease": False, "prefersPrerelease": False},
        },
        "release": {
            "channel": "preview",
            "commit": commit,
            "manifest": "RELEASE_MANIFEST.json",
            "prerelease": True,
            "tag": tag,
            "tagObject": tag_object,
        },
        "repository": REPOSITORY,
        "schemaVersion": 1,
        "targets": installers,
    }
    write_json(release_dir / "RELEASE_INDEX.json", index)

    payload_names = sorted(
        [str(item["name"]) for item in installers]
        + ["BUILD_METADATA.json", "RELEASE_INDEX.json", "RELEASE_NOTES.md", "RELEASE_NOTES.zh-CN.md"]
    )
    manifest_assets = []
    for name in payload_names:
        path = release_dir / name
        asset = classify_asset(name, installers)
        asset["sha256"] = f"sha256:{sha256(path)}"
        asset["size"] = path.stat().st_size
        manifest_assets.append(asset)
    manifest = {
        "assetCountTotal": 13,
        "assets": manifest_assets,
        "channel": "preview",
        "checksumAsset": "SHA256SUMS.txt",
        "commit": commit,
        "manifestSelfCoveredBy": "SHA256SUMS.txt",
        "prerelease": True,
        "schemaVersion": 1,
        "sha256EntryCount": 12,
        "tag": tag,
        "tagObject": tag_object,
    }
    write_json(release_dir / "RELEASE_MANIFEST.json", manifest)

    checksum_names = sorted(path.name for path in release_dir.iterdir() if path.is_file())
    if len(checksum_names) != 12 or "SHA256SUMS.txt" in checksum_names:
        fail(f"expected 12 assets before checksum generation, found {checksum_names}")
    write_text(
        release_dir / "SHA256SUMS.txt",
        "".join(f"{sha256(release_dir / name)}  {name}\n" for name in checksum_names),
    )


def self_test(root: Path, golden_path: Path, emit_golden: bool) -> None:
    observed: list[dict[str, str]] = []
    with tempfile.TemporaryDirectory(prefix="prism-release-assets-") as temp:
        temp_root = Path(temp)
        for run in ("first", "second"):
            release_dir = temp_root / run / "release"
            artifacts_dir = temp_root / run / "artifacts"
            release_dir.mkdir(parents=True)
            for target, (_, _, suffixes) in TARGETS.items():
                for suffix in suffixes:
                    path = release_dir / f"tachyon-prism-{target}_fixture{suffix}"
                    path.write_bytes(f"fixture:{target}:{suffix}\n".encode("ascii"))
                status = artifacts_dir / f"tachyon-prism-{target}" / "release-status"
                status.mkdir(parents=True)
                value = "not-applicable-unsigned" if target.startswith("linux-") else "unsigned-no-credentials"
                write_text(status / f"{target}.txt", value + "\n")
            prepare(
                release_dir=release_dir,
                artifacts_dir=artifacts_dir,
                tag="v0.1.0-alpha.1",
                commit="a" * 40,
                tag_object="b" * 40,
                source_date_epoch=1_700_000_000,
                core_contract_path=Path("core-contract.json"),
                tool_versions_path=Path(".tool-versions"),
            )
            observed.append({name: sha256(release_dir / name) for name in AUXILIARY_NAMES})
    if observed[0] != observed[1]:
        fail("two release metadata runs were not byte-for-byte reproducible")
    if emit_golden:
        print(json.dumps(observed[0], indent=2, sort_keys=True))
        return
    expected = load_object(golden_path, "release asset golden")
    if observed[0] != expected:
        fail("release metadata differs from the checked cross-platform golden")
    print("release asset reproducibility valid: 2 identical runs, 6 metadata assets")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-dir", type=Path)
    parser.add_argument("--artifacts-dir", type=Path)
    parser.add_argument("--tag")
    parser.add_argument("--commit")
    parser.add_argument("--tag-object")
    parser.add_argument("--source-date-epoch", type=int)
    parser.add_argument("--core-contract", type=Path, default=Path("core-contract.json"))
    parser.add_argument("--tool-versions", type=Path, default=Path(".tool-versions"))
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--golden", type=Path, default=Path("scripts/release-assets.golden.json"))
    parser.add_argument("--emit-golden", action="store_true")
    args = parser.parse_args()
    try:
        if args.self_test:
            self_test(Path.cwd(), args.golden, args.emit_golden)
        else:
            required = {
                "release_dir": args.release_dir,
                "artifacts_dir": args.artifacts_dir,
                "tag": args.tag,
                "commit": args.commit,
                "tag_object": args.tag_object,
                "source_date_epoch": args.source_date_epoch,
            }
            missing = [name for name, value in required.items() if value is None]
            if missing:
                fail("missing production arguments: " + ", ".join(missing))
            prepare(
                release_dir=args.release_dir,
                artifacts_dir=args.artifacts_dir,
                tag=args.tag,
                commit=args.commit,
                tag_object=args.tag_object,
                source_date_epoch=args.source_date_epoch,
                core_contract_path=args.core_contract,
                tool_versions_path=args.tool_versions,
            )
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"release asset preparation failed: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
