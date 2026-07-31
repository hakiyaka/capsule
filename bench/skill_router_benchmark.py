#!/usr/bin/env python3
"""Measure virtual skill routing against the user's real direct-skill catalog."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path


CASES = [
    ("authorized Android APK reverse engineering", {"apk-reverse", "mobile-reverse", "apk-redteam-pipeline"}),
    ("analyze a stripped Go binary", {"go-rust-reverse"}),
    ("find SQL injection in a web API", {"hunt-sqli"}),
    ("hunt an IDOR authorization flaw", {"hunt-idor"}),
    ("audit OAuth account takeover", {"hunt-oauth", "hunt-ato", "competition-oauth-oidc-chain"}),
    ("write a bug bounty vulnerability report", {"report-writing", "bugcrowd-reporting", "bug-bounty"}),
    ("automate a browser with Playwright", {"playwright", "browser-automation"}),
    ("inspect and verify a PDF", {"pdf"}),
    ("diagnose a hard performance regression bug", {"diagnosing-bugs"}),
    ("audit a smart contract for DeFi vulnerabilities", {"web3-audit", "meme-coin-audit"}),
    ("assess Active Directory security", {"windows-ad", "competition-identity-windows"}),
    ("pentest IoT firmware", {"firmware-pentest"}),
    ("reverse a .NET assembly", {"dotnet-reverse"}),
    ("audit cloud IAM permissions", {"cloud-iam-deep", "cloud-k8s", "hunt-cloud-misconfig"}),
    ("build a pwn exploit chain", {"pwn-chain", "competition-reverse-pwn"}),
]


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write")
    return parser.parse_args()


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).resolve()


def catalog_root(home: Path) -> tuple[Path, bool]:
    manifest = home / "capsule-skill-vault" / "manifest.json"
    if manifest.is_file():
        data = json.loads(manifest.read_text(encoding="utf-8"))
        if data.get("active") and data.get("snapshot_root"):
            return Path(data["snapshot_root"]) / "entries", True
    return home / "skills", False


def metadata(root: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    if not root.is_dir():
        return rows
    for file in root.rglob("SKILL.md"):
        relative = file.relative_to(root)
        if relative.parts and relative.parts[0].startswith("."):
            continue
        text = file.read_text(encoding="utf-8", errors="replace")[:64_000]
        match = re.match(r"^---\s*\r?\n(.*?)\r?\n---", text, re.S)
        if not match:
            continue
        block = match.group(1)
        name = re.search(r"^name:\s*(.+)$", block, re.M)
        description = re.search(r"^description:\s*(.+)$", block, re.M)
        if not name:
            continue
        rows.append(
            {
                "name": name.group(1).strip().strip("'\""),
                "description": description.group(1).strip().strip("'\"") if description else "",
                "path": str(file),
            }
        )
    return rows


def tokenizer():
    try:
        import tiktoken  # type: ignore

        encoding = tiktoken.get_encoding("o200k_base")
        return "o200k_base", lambda value: len(encoding.encode(value))
    except Exception:
        return "four_chars_estimate", lambda value: (len(value) + 3) // 4


def route(plugin: Path, query: str) -> dict:
    completed = subprocess.run(
        ["node", str(plugin / "scripts" / "skill-router.cjs"), "route", query],
        cwd=plugin,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return json.loads(completed.stdout)


def main() -> None:
    options = args()
    plugin = Path(__file__).resolve().parent.parent
    root, active = catalog_root(codex_home())
    rows = metadata(root)
    available_names = {item["name"] for item in rows}
    baseline = "\n".join(
        f"- {item['name']}: {item['description']} (file: {item['path']})"
        for item in rows
    )
    tokenizer_name, count_tokens = tokenizer()
    baseline_tokens = count_tokens(baseline)
    results = []
    treatment_tokens = 0
    for query, expected in CASES:
        available_expected = expected.intersection(available_names)
        if not available_expected:
            results.append(
                {
                    "query": query,
                    "top3": [],
                    "pass": None,
                    "skipped": "No expected specialist exists in the active direct-skill catalog.",
                    "route_tokens": 0,
                }
            )
            continue
        response = route(plugin, query)
        names = [item["name"] for item in response.get("matches", [])]
        serialized = json.dumps(response, ensure_ascii=False, separators=(",", ":"))
        route_tokens = count_tokens(serialized)
        treatment_tokens += route_tokens
        results.append(
            {
                "query": query,
                "top3": names,
                "pass": bool(available_expected.intersection(names)),
                "route_tokens": route_tokens,
            }
        )
    evaluated = [item for item in results if item["pass"] is not None]
    a_total = baseline_tokens * len(evaluated)
    b_total = treatment_tokens
    output = {
        "method": {
            "scope": "Marginal specialist-skill metadata and route-result tokens; selected SKILL.md bodies cancel from both arms.",
            "a": "Expose every direct specialist's metadata on every task.",
            "b": "Expose one compact Capsule route result per task.",
            "tokenizer": tokenizer_name,
            "exclusions": "System/plugin skills, selected skill bodies, provider caching, billing, and answer tokens.",
        },
        "catalog": {
            "virtualized": active,
            "skills": len(rows),
            "baseline_metadata_tokens_per_task": baseline_tokens,
        },
        "summary": {
            "tasks": len(CASES),
            "evaluated_tasks": len(evaluated),
            "skipped_tasks": len(results) - len(evaluated),
            "top3_passes": sum(item["pass"] for item in evaluated),
            "top3_accuracy_percent": round(sum(item["pass"] for item in evaluated) / len(evaluated) * 100, 2) if evaluated else 0,
            "a_total_tokens": a_total,
            "b_total_tokens": b_total,
            "weighted_saving_percent": round((a_total - b_total) / a_total * 100, 2) if a_total else 0,
            "average_route_tokens": round(b_total / len(evaluated), 2) if evaluated else 0,
        },
        "cases": results,
    }
    rendered = json.dumps(output, ensure_ascii=False, indent=2) + "\n"
    if options.write:
        Path(options.write).resolve().write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    if output["summary"]["top3_passes"] != len(evaluated):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
