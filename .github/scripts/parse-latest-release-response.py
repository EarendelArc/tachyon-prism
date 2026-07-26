#!/usr/bin/env python3
"""Parse one `gh api --include` response without treating API failures as 404."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


STATUS_LINE = re.compile(r"^HTTP/\S+\s+([0-9]{3})(?:\s+.*)?$")


def fail(message: str) -> None:
    raise ValueError(message)


def parse_response(path: Path, command_status: int) -> str:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    status_indexes: list[tuple[int, int]] = []
    for index, line in enumerate(lines):
        match = STATUS_LINE.fullmatch(line.rstrip("\r"))
        if match:
            status_indexes.append((index, int(match.group(1))))
    if not status_indexes:
        fail("GitHub Latest response did not contain an HTTP status line")

    status_index, status = status_indexes[-1]
    body_start = None
    for index in range(status_index + 1, len(lines)):
        if lines[index].rstrip("\r") == "":
            body_start = index + 1
            break
    if body_start is None:
        fail("GitHub Latest response did not contain a header/body separator")
    body = "\n".join(lines[body_start:]).strip()

    if status == 404:
        return "__NONE__"
    if status != 200:
        fail(f"GitHub Latest API returned HTTP {status}; refusing to publish unverifiably")
    if command_status != 0:
        fail(f"GitHub Latest API command failed with exit status {command_status}")
    payload = json.loads(body)
    if not isinstance(payload, dict) or not isinstance(payload.get("tag_name"), str):
        fail("GitHub Latest response is missing string tag_name")
    return payload["tag_name"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--response", type=Path, required=True)
    parser.add_argument("--command-status", type=int, required=True)
    args = parser.parse_args()
    try:
        print(parse_response(args.response, args.command_status))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Latest release validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
