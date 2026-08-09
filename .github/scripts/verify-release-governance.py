#!/usr/bin/env python3
"""Verify repository controls before any GitHub Release write occurs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


REQUIRED_TAG_RULE_TYPES = {"deletion", "non_fast_forward", "update"}
REQUIRED_MAIN_RULE_TYPES = {
    "deletion",
    "non_fast_forward",
    "pull_request",
    "required_status_checks",
}
RELEASE_TAG_PATTERN = "refs/tags/v*"
MAIN_BRANCH_PATTERN = "refs/heads/main"
REQUIRED_STATUS_CONTEXT = "Required CI gate"


def fail(message: str) -> None:
    raise ValueError(message)


def load_object(path: Path, description: str) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"{description} response must be a JSON object")
    return value


def base_ruleset_matches(
    ruleset: dict[str, object], target: str, pattern: str
) -> tuple[bool, set[str]]:
    if ruleset.get("target") != target or ruleset.get("enforcement") != "active":
        return False, set()
    bypass_actors = ruleset.get("bypass_actors")
    if not isinstance(bypass_actors, list) or bypass_actors:
        return False, set()
    conditions = ruleset.get("conditions")
    if not isinstance(conditions, dict):
        return False, set()
    ref_name = conditions.get("ref_name")
    if not isinstance(ref_name, dict):
        return False, set()
    includes = ref_name.get("include")
    excludes = ref_name.get("exclude")
    if not isinstance(includes, list) or pattern not in includes or excludes != []:
        return False, set()
    rules = ruleset.get("rules")
    if not isinstance(rules, list):
        return False, set()
    return True, {
        rule.get("type")
        for rule in rules
        if isinstance(rule, dict) and isinstance(rule.get("type"), str)
    }


def qualifying_tag_ruleset(ruleset: dict[str, object]) -> bool:
    matched, rule_types = base_ruleset_matches(ruleset, "tag", RELEASE_TAG_PATTERN)
    return matched and REQUIRED_TAG_RULE_TYPES.issubset(rule_types)


def qualifying_main_ruleset(ruleset: dict[str, object]) -> bool:
    matched, rule_types = base_ruleset_matches(ruleset, "branch", MAIN_BRANCH_PATTERN)
    if not matched or not REQUIRED_MAIN_RULE_TYPES.issubset(rule_types):
        return False
    rules = ruleset.get("rules")
    status_rule = next(
        (
            rule
            for rule in rules
            if isinstance(rule, dict) and rule.get("type") == "required_status_checks"
        ),
        None,
    )
    if not isinstance(status_rule, dict):
        return False
    parameters = status_rule.get("parameters")
    if not isinstance(parameters, dict):
        return False
    checks = parameters.get("required_status_checks")
    if not isinstance(checks, list):
        return False
    contexts = {
        check.get("context")
        for check in checks
        if isinstance(check, dict) and isinstance(check.get("context"), str)
    }
    return (
        REQUIRED_STATUS_CONTEXT in contexts
        and parameters.get("strict_required_status_checks_policy") is True
    )


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
            fail("repository has no rulesets protecting release tags and main")

        rulesets = [load_object(path, f"ruleset {path.name}") for path in args.ruleset_json]
        if not any(qualifying_tag_ruleset(ruleset) for ruleset in rulesets):
            fail(
                "repository must have an active, zero-bypass tag ruleset covering "
                "refs/tags/v* and blocking deletion, update, and non-fast-forward"
            )
        if not any(qualifying_main_ruleset(ruleset) for ruleset in rulesets):
            fail(
                "repository must have an active, zero-bypass main ruleset requiring "
                "pull requests, deletion/non-fast-forward protection, and strict "
                "Required CI gate"
            )
        print(
            "release governance valid: immutable releases, protected refs/tags/v*, "
            "and strict main Required CI gate"
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"release governance validation failed: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
