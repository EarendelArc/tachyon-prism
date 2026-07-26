#!/usr/bin/env python3
"""Verify repository controls before any GitHub Release write occurs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


REQUIRED_RULE_TYPES = {"deletion", "non_fast_forward", "update"}
RELEASE_TAG_PATTERN = "refs/tags/v*"


def fail(message: str) -> None:
    raise ValueError(message)


def load_object(path: Path, description: str) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"{description} response must be a JSON object")
    return value


def qualifying_ruleset(ruleset: dict[str, object]) -> bool:
    if ruleset.get("target") != "tag" or ruleset.get("enforcement") != "active":
        return False

    bypass_actors = ruleset.get("bypass_actors")
    if not isinstance(bypass_actors, list) or bypass_actors:
        return False

    conditions = ruleset.get("conditions")
    if not isinstance(conditions, dict):
        return False
    ref_name = conditions.get("ref_name")
    if not isinstance(ref_name, dict):
        return False
    includes = ref_name.get("include")
    excludes = ref_name.get("exclude")
    if not isinstance(includes, list) or RELEASE_TAG_PATTERN not in includes:
        return False
    if excludes != []:
        return False

    rules = ruleset.get("rules")
    if not isinstance(rules, list):
        return False
    rule_types = {
        rule.get("type")
        for rule in rules
        if isinstance(rule, dict) and isinstance(rule.get("type"), str)
    }
    return REQUIRED_RULE_TYPES.issubset(rule_types)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--immutable-json", type=Path, required=True)
    parser.add_argument("--ruleset-json", type=Path, action="append", default=[])
    args = parser.parse_args()

    try:
        immutable = load_object(args.immutable_json, "immutable releases")
        if immutable.get("enabled") is not True:
            fail("GitHub immutable releases must be enabled before publication")
        if not args.ruleset_json:
            fail("repository has no tag rulesets to protect release tags")

        rulesets = [load_object(path, f"ruleset {path.name}") for path in args.ruleset_json]
        if not any(qualifying_ruleset(ruleset) for ruleset in rulesets):
            fail(
                "repository must have an active, zero-bypass tag ruleset covering "
                "refs/tags/v* and blocking deletion, update, and non-fast-forward"
            )
        print("release governance valid: immutable releases and protected refs/tags/v*")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"release governance validation failed: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
