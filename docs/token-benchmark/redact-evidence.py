#!/usr/bin/env python3
"""Structurally redact private system-prompt material from benchmark JSONL."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


EVIDENCE_ROOT = Path(__file__).parent / "evidence"
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
HOME_PREFIX = str(Path.home())
ALLOWED_HOME_PATHS = (
    str(Path.home() / "Projects/log-rotator"),
    str(REPOSITORY_ROOT),
)
SKILL_ENTRY = re.compile(r"<skill\b.*?</skill\s*>", re.IGNORECASE | re.DOTALL)
SKILL_OPEN = re.compile(r"<skill\b", re.IGNORECASE)


def is_placeholder(value: str, kind: str) -> bool:
    return value.startswith(f"[REDACTED {kind}:")


def redact_section(
    sections: dict[str, Any], key: str, kind: str, counters: dict[str, int],
    private_chunks: list[str],
) -> None:
    value = sections.get(key)
    if not isinstance(value, str) or is_placeholder(value, kind):
        return

    byte_count = len(value.encode("utf-8"))
    if key == "skills":
        entries = len(SKILL_OPEN.findall(value))
        private_chunks.extend(SKILL_ENTRY.findall(value))
        sections[key] = f"[REDACTED skills inventory: {entries} entries, {byte_count} bytes]"
    elif key == "project_context":
        private_chunks.append(value)
        sections[key] = f"[REDACTED project context: {byte_count} bytes]"
    elif key == "rules":
        private_chunks.append(value)
        sections[key] = f"[REDACTED global rules: {byte_count} bytes]"
    counters[key] = counters.get(key, 0) + 1


def redact_home_paths(text: str) -> tuple[str, int]:
    """Replace personal home prefixes except the benchmark checkout and this repo."""
    result: list[str] = []
    cursor = 0
    replaced = 0
    while True:
        start = text.find(HOME_PREFIX, cursor)
        if start < 0:
            result.append(text[cursor:])
            break
        result.append(text[cursor:start])
        tail = text[start:]
        allowed = next((prefix for prefix in ALLOWED_HOME_PATHS if tail.startswith(prefix)), None)
        if allowed is not None:
            boundary = start + len(allowed)
            if boundary == len(text) or text[boundary] in "/\\ \t\r\n'\"<>),;:!?]}":
                result.append(allowed)
                cursor = boundary
                continue
        result.append("~")
        replaced += 1
        cursor = start + len(HOME_PREFIX)
    return "".join(result), replaced


def redact_metadata(value: Any, counters: dict[str, int]) -> Any:
    """Redact home paths in metadata while preserving user prompts and tool data."""
    if isinstance(value, str):
        cleaned, count = redact_home_paths(value)
        counters["home_paths"] = counters.get("home_paths", 0) + count
        return cleaned
    if isinstance(value, list):
        return [redact_metadata(item, counters) for item in value]
    if not isinstance(value, dict):
        return value

    if value.get("type") == "message":
        message = value.get("message")
        if not isinstance(message, dict):
            return value
        if message.get("role") != "system":
            return value

        sections = message.get("sections")
        if isinstance(sections, dict):
            for key, kind in (
                ("skills", "skills inventory"),
                ("project_context", "project context"),
                ("rules", "global rules"),
            ):
                redact_section(sections, key, kind, counters, PRIVATE_CHUNKS)
        value["message"] = redact_metadata(message, counters)
        return value

    if value.get("type") == "custom_message":
        # This is the measured result delivered to the parent, not metadata.
        return value

    return {key: redact_metadata(item, counters) for key, item in value.items()}


PRIVATE_CHUNKS: list[str] = []


def usage_snapshot(entries: list[dict[str, Any]]) -> list[Any]:
    snapshot = []
    for entry in entries:
        if entry.get("type") != "message":
            continue
        message = entry.get("message", {})
        usage = message.get("usage") if isinstance(message, dict) else None
        if isinstance(usage, dict):
            snapshot.append(usage)
    return snapshot


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else EVIDENCE_ROOT
    files = sorted(path for path in root.rglob("*.jsonl") if path.is_file() and not path.is_symlink())
    if not files:
        raise SystemExit(f"no JSONL evidence files found under {root}")

    total_counts: dict[str, int] = {}
    outputs: list[tuple[Path, list[str], list[Any]]] = []
    for path in files:
        entries = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        before_usage = usage_snapshot(entries)
        counters: dict[str, int] = {}
        transformed = [redact_metadata(entry, counters) for entry in entries]
        if usage_snapshot(transformed) != before_usage:
            raise RuntimeError(f"usage changed during redaction: {path}")
        for key, count in counters.items():
            total_counts[key] = total_counts.get(key, 0) + count
        outputs.append((path, [json.dumps(entry, ensure_ascii=False, separators=(",", ":")) for entry in transformed], before_usage))

    # Write only after every source file parses and every usage snapshot matches.
    for path, lines, before_usage in outputs:
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        written = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        if usage_snapshot(written) != before_usage:
            raise RuntimeError(f"usage changed after writing: {path}")
        for chunk in PRIVATE_CHUNKS:
            if chunk and chunk.encode("utf-8") in path.read_bytes():
                raise RuntimeError(f"a redacted private section remains in {path}")

    print(
        f"redacted {len(files)} JSONL files; sections: "
        f"skills={total_counts.get('skills', 0)}, "
        f"project_context={total_counts.get('project_context', 0)}, "
        f"rules={total_counts.get('rules', 0)}; "
        f"home-path replacements={total_counts.get('home_paths', 0)}; "
        "usage snapshots unchanged"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
