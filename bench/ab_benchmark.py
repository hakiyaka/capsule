from __future__ import annotations

import json
import hashlib
import statistics
import subprocess
import sys
from pathlib import Path

import tiktoken


ROOT = Path(__file__).resolve().parent


def count(encoding, text: str) -> int:
    return len(encoding.encode(text))

def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    cases_name = "cases.cjs"
    if "--cases" in sys.argv:
        cases_name = sys.argv[sys.argv.index("--cases") + 1]
    cases_path = ROOT / cases_name
    generated = subprocess.run(
        ["node", str(cases_path)],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    data = json.loads(generated.stdout)
    encoding = tiktoken.encoding_for_model(data["tokenizer_model"])
    schema_tokens = count(encoding, data["activation_overhead"]["tool_schema"])
    skill_tokens = count(encoding, data["activation_overhead"]["skill"])
    optional_skill_tokens = count(encoding, data["activation_overhead"]["optional_skill"])
    instruction_tokens = count(encoding, data["activation_overhead"]["server_instructions"])
    activation_tokens = schema_tokens + skill_tokens + instruction_tokens

    rows = []
    total_a = 0
    total_b = 0
    for case in data["cases"]:
        shared = case["prompt"] + "\n"
        baseline_tokens = count(encoding, shared + case["baseline"])
        payload_tokens = count(encoding, shared + case["treatment"])
        treatment_tokens = payload_tokens + (activation_tokens if case["invoked"] else 0)
        saved = baseline_tokens - treatment_tokens
        percent = 0.0 if baseline_tokens == 0 else saved / baseline_tokens * 100
        missing = [needle for needle in case["expected"] if needle not in case["treatment"]]
        rows.append(
            {
                "task": case["name"],
                "category": case["category"],
                "route": case["route"],
                "invoked": case["invoked"],
                "selection": case["selection"],
                "a_tokens": baseline_tokens,
                "b_tokens": treatment_tokens,
                "saved_tokens": saved,
                "saving_percent": round(percent, 2),
                "quality_pass": not missing,
                "missing_evidence": missing,
            }
        )
        total_a += baseline_tokens
        total_b += treatment_tokens

    percentages = [row["saving_percent"] for row in rows]
    positive = [value for value in percentages if value > 0]
    regressions = [row for row in rows if row["saved_tokens"] < 0]
    quality_failures = [row for row in rows if not row["quality_pass"]]
    activated = [row for row in rows if row["invoked"]]
    activated_a = sum(row["a_tokens"] for row in activated)
    activated_b = sum(row["b_tokens"] for row in activated)
    eager_total_b = sum(
        row["b_tokens"] + (0 if row["invoked"] else activation_tokens) for row in rows
    )
    eager_regressions = sum(
        row["b_tokens"] + (0 if row["invoked"] else activation_tokens) > row["a_tokens"]
        for row in rows
    )
    eager_percentages = [
        (
            row["a_tokens"]
            - row["b_tokens"]
            - (0 if row["invoked"] else activation_tokens)
        )
        / row["a_tokens"]
        * 100
        for row in rows
    ]
    selective_optional_total_b = total_b + optional_skill_tokens * len(activated)
    selective_optional_regressions = sum(
        row["b_tokens"] + (optional_skill_tokens if row["invoked"] else 0) > row["a_tokens"]
        for row in rows
    )
    eager_optional_total_b = eager_total_b + optional_skill_tokens * len(rows)
    eager_optional_regressions = sum(
        row["b_tokens"]
        + (0 if row["invoked"] else activation_tokens)
        + optional_skill_tokens
        > row["a_tokens"]
        for row in rows
    )
    eager_optional_percentages = [
        (
            row["a_tokens"]
            - row["b_tokens"]
            - (0 if row["invoked"] else activation_tokens)
            - optional_skill_tokens
        )
        / row["a_tokens"]
        * 100
        for row in rows
    ]
    output = {
        "method": {
            "tokenizer": encoding.name,
            "tiktoken_version": getattr(tiktoken, "__version__", "unknown"),
            "scope": "Input-token exposure when full raw ingestion is replaced; generated answers, billing, latency, storage I/O, and tool-call envelopes are excluded.",
            "quality_scope": "Deterministic literal-evidence transport and lossless-decode checks; not model-answer correctness.",
            "activation_policy": "Selective simulation charges activation only when a transform is emitted; actual always-on sensitivities are reported separately.",
            "selector_is_simulated": True,
            "activation_overhead_tokens_per_invoked_task": activation_tokens,
            "tool_schema_tokens": schema_tokens,
            "skill_tokens": skill_tokens,
            "optional_skill_tokens_not_counted": optional_skill_tokens,
            "server_instruction_tokens": instruction_tokens,
            "policy_threshold_chars": data["policy_threshold_chars"],
            "evidence_budget_chars": data["evidence_budget_chars"],
            "source_sha256": {
                "core.cjs": sha256(ROOT.parent / "mcp" / "core.cjs"),
                "unified.cjs": sha256(ROOT.parent / "mcp" / "unified.cjs"),
                "schema.cjs": sha256(ROOT.parent / "mcp" / "schema.cjs"),
                "hook.cjs": sha256(ROOT.parent / "scripts" / "hook.cjs"),
                "SKILL.md": sha256(ROOT.parent / "skills" / "map-token-context" / "SKILL.md"),
                cases_name: sha256(cases_path),
                "ab_benchmark.py": sha256(Path(__file__)),
            },
        },
        "summary": {
            "tasks": len(rows),
            "positive_tasks": len(positive),
            "positive_task_percent": round(len(positive) / len(rows) * 100, 2),
            "neutral_tasks": sum(value == 0 for value in percentages),
            "regressions": len(regressions),
            "non_regression_task_percent": round(
                sum(row["saved_tokens"] >= 0 for row in rows) / len(rows) * 100, 2
            ),
            "quality_failures": len(quality_failures),
            "a_total_tokens": total_a,
            "b_total_tokens": total_b,
            "weighted_saving_percent": round((total_a - total_b) / total_a * 100, 2),
            "activated_weighted_saving_percent": round(
                (activated_a - activated_b) / activated_a * 100, 2
            ),
            "selective_with_optional_skill_b_total_tokens": selective_optional_total_b,
            "selective_with_optional_skill_weighted_saving_percent": round(
                (total_a - selective_optional_total_b) / total_a * 100, 2
            ),
            "selective_with_optional_skill_regressions": selective_optional_regressions,
            "eager_always_on_b_total_tokens": eager_total_b,
            "eager_always_on_weighted_saving_percent": round(
                (total_a - eager_total_b) / total_a * 100, 2
            ),
            "eager_always_on_regressions": eager_regressions,
            "eager_always_on_positive_tasks": sum(value > 0 for value in eager_percentages),
            "eager_always_on_non_regression_task_percent": round(
                sum(value >= 0 for value in eager_percentages) / len(rows) * 100, 2
            ),
            "eager_always_on_min_saving_percent": round(min(eager_percentages), 2),
            "eager_always_on_with_optional_skill_b_total_tokens": eager_optional_total_b,
            "eager_always_on_with_optional_skill_weighted_saving_percent": round(
                (total_a - eager_optional_total_b) / total_a * 100, 2
            ),
            "eager_always_on_with_optional_skill_regressions": eager_optional_regressions,
            "eager_always_on_with_optional_skill_min_saving_percent": round(
                min(eager_optional_percentages), 2
            ),
            "macro_saving_percent": round(statistics.mean(percentages), 2),
            "median_saving_percent": round(statistics.median(percentages), 2),
            "min_positive_saving_percent": round(min(positive), 2) if positive else 0,
            "max_saving_percent": round(max(percentages), 2),
        },
        "tasks": rows,
    }
    if "--write" in sys.argv:
        index = sys.argv.index("--write")
        target = Path(sys.argv[index + 1])
        target.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if "--summary" in sys.argv:
        print(json.dumps({"method": output["method"], "summary": output["summary"]}, ensure_ascii=False))
    else:
        print(json.dumps(output, ensure_ascii=False, indent=2))
    return 1 if regressions or quality_failures else 0


if __name__ == "__main__":
    sys.exit(main())
