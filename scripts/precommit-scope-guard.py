#!/usr/bin/env python3
"""Read-only checks of staged migration paths and newly added text.

This complements Gitleaks. It never stages files, changes the index, or prints
suspected secret values. Run `python3 scripts/precommit-scope-guard.py --self-test`
without staging anything to check its positive and negative cases.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import PurePosixPath


REGISTRY = "ops/markets/tier1.json"
V2_GENERATOR = "ops/v2-env.mjs"
KEEPER_GENERATOR = "ops/keeper-env.sh"
V2_ENV_NAMES = frozenset({
    "indexer-v2", "cranker", "pricing", "mm-bot", "pricer", "notifier",
})
KEEPER_ENV_STATUSES = frozenset({"live", "planned", "superseded-by-v2"})
THIRD_PARTY_FIXTURE_REASON = "third-party options-chain fixture pending redistribution review"


def git(*args: str) -> bytes:
    # This macOS host's /usr/bin/git is unusable until its Xcode license is
    # accepted; prefer the normal Homebrew binary when available.
    brew_git = "/opt/homebrew/bin/git"
    git_executable = brew_git if os.path.isfile(brew_git) else shutil.which("git")
    if not git_executable:
        raise FileNotFoundError("git not found")
    return subprocess.run(
        [git_executable, *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    ).stdout


def path_problem(path: str, approved_generated_envs: frozenset[str] = frozenset()) -> str | None:
    parts = PurePosixPath(path).parts
    name = parts[-1] if parts else ""
    lower = name.lower()

    if lower == "llms.txt" or lower.endswith((
        ".md", ".mdx", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdwn", ".mdtxt", ".mdtext",
    )):
        return "Markdown path change excluded from this code-only migration"
    if path == "ops/runbooks.test.mjs":
        return "test depends on withheld Markdown runbooks"
    if path in {"CLAUDE.md", "ops/devnet/addresses.json", "ops/devnet/state.json"}:
        return "local-only development or assistant artifact"
    if len(parts) >= 4 and parts[:3] == ("keeper", "src", "fixtures") and lower.endswith(".json"):
        return THIRD_PARTY_FIXTURE_REASON
    if any(
        part in {
            ".codex", ".claude", ".next", ".pnpm-store", "node_modules",
            "broadcast", "out", "cache", "build", "dist",
        }
        for part in parts
    ):
        return "local-only generated artifact"
    if name in {"rehearsal-passed.json", "verify-flags.patch.untracked"}:
        return "local-only rehearsal or patch artifact"
    if lower == ".env" or lower.startswith(".env.") or lower.endswith(".env"):
        if path not in approved_generated_envs and not lower.endswith((".example", ".sample", ".template")):
            return "non-template environment file"
    if lower.endswith((".pem", ".p12", ".pfx", ".keystore", ".key")):
        return "key material or keystore"
    if len(parts) >= 2 and parts[0] == "ops" and parts[1] == "devnet":
        if lower.endswith((".log", ".pid", ".db", ".sqlite")):
            return "local-only devnet runtime artifact"
    return None


# Assemble local machine markers so this script does not match its own source.
PRIVATE_PATH = re.compile(
    r"(?:/" + "Users" + r"/[^/\s]+/|/" + "home" + r"/[^/\s]+/|"
    + r"/private/" + "tmp" + r"/|"
    + "stonkhouse" + r"-plan(?:/|\b)|"
    + "robinhood" + r"-dev(?:/|\b)|"
    + "wt/" + r"callhouse(?:-|/))",
    re.IGNORECASE,
)


def inspect(
    paths: list[str], added_lines: list[str], approved_pin: str | None, staged_pin: str | None,
    approved_generated_envs: frozenset[str] = frozenset(),
    deleted_paths: frozenset[str] = frozenset(),
) -> list[str]:
    problems: list[str] = []
    for path in paths:
        reason = path_problem(path, approved_generated_envs)
        # Removing a previously published captured fixture is the desired cleanup.
        # A new or modified JSON fixture must still fail, including a rename target.
        if reason and not (reason == THIRD_PARTY_FIXTURE_REASON and path in deleted_paths):
            problems.append(f"{path}: {reason}")
    if "contracts" in paths:
        if not staged_pin or approved_pin != staged_pin:
            problems.append(
                "contracts: staged gitlink requires an independently verified public pin; "
                "set CALLHOUSE_APPROVED_PUBLIC_CONTRACTS_PIN to the exact reviewed SHA"
            )
    if any(PRIVATE_PATH.search(line) for line in added_lines):
        problems.append("staged additions contain a private machine/worktree path")
    return problems


def generated_env_allowlist(registry_bytes: bytes) -> frozenset[str]:
    """Only the six fixed service files and exact market names rendered by the registry."""
    registry = json.loads(registry_bytes)
    markets = registry["markets"]
    if not isinstance(markets, list):
        raise ValueError("registry markets is not a list")
    allowed = {f"ops/v2/env/{name}.env" for name in V2_ENV_NAMES}
    tickers: set[str] = set()
    for market in markets:
        if not isinstance(market, dict):
            raise ValueError("invalid registry market")
        ticker = market.get("ticker")
        if not isinstance(ticker, str) or not re.fullmatch(r"[A-Z][A-Z0-9]{0,11}", ticker):
            raise ValueError("invalid registry ticker")
        if ticker in tickers:
            raise ValueError("duplicate registry ticker")
        tickers.add(ticker)
        if market.get("status") in KEEPER_ENV_STATUSES:
            allowed.add(f"ops/keeper/markets/{ticker}.env")
    return frozenset(allowed)


def staged_blob(path: str) -> bytes | None:
    try:
        return git("show", f":{path}")
    except subprocess.CalledProcessError:
        return None


def worktree_blob(path: str) -> bytes | None:
    if os.path.islink(path):
        return None
    try:
        with open(path, "rb") as file:
            return file.read()
    except OSError:
        return None


def generator_matches(generator: str) -> bool:
    # Both generators' --check mode is read-only. Do not print their output: a
    # mismatch diagnostic can contain a line from an environment file.
    try:
        result = subprocess.run(
            ["node", generator, "--check"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False,
        )
    except OSError:
        return False
    return result.returncode == 0


def validate_generated_envs(
    paths: list[str], index_bytes=staged_blob, disk_bytes=worktree_blob,
    run_check=generator_matches,
) -> tuple[frozenset[str], list[str]]:
    """Approve generated env files only when the staged snapshot matches a checked render.

    Comparing the registry and renderer inputs too prevents a partially staged
    registry/renderer/env combination from passing against the working tree.
    """
    requested = {
        path for path in paths
        if path.endswith(".env") and (
            path.startswith("ops/v2/env/") or path.startswith("ops/keeper/markets/")
        )
    }
    if not requested:
        return frozenset(), []

    staged_registry = index_bytes(REGISTRY)
    if staged_registry is None or staged_registry != disk_bytes(REGISTRY):
        return frozenset(), ["generated env: staged registry must match the working tree"]
    try:
        allowed = generated_env_allowlist(staged_registry)
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return frozenset(), ["generated env: staged registry has invalid market metadata"]

    candidates = requested & allowed
    generators = set()
    if any(path.startswith("ops/v2/env/") for path in candidates):
        generators.add(V2_GENERATOR)
    if any(path.startswith("ops/keeper/markets/") for path in candidates):
        generators.add(KEEPER_GENERATOR)
    problems = []
    for path in sorted(candidates | generators):
        staged = index_bytes(path)
        if staged is None or staged != disk_bytes(path):
            problems.append(f"{path}: staged bytes must match the working tree")
    if problems:
        return frozenset(), problems
    for generator in sorted(generators):
        if not run_check(generator):
            problems.append(f"{generator}: generated environment drift check failed")
    return (frozenset(candidates), []) if not problems else (frozenset(), problems)


def self_test() -> int:
    assert inspect([], [], None, None) == []
    assert inspect(["web/.env.example", "ops/devnet/up.sh"], ["public docs"], None, None) == []
    assert path_problem("ops/devnet/addresses.json")
    assert path_problem("keeper/src/fixtures/cboe-tsla-2026-09-16.json")
    assert path_problem("keeper/src/fixtures/cboe-nvda-2026-09-14.json")
    assert path_problem("keeper/src/fixtures/renamed-captured-chain.json")
    assert path_problem("keeper/src/fixtures/synthetic-chains.ts") is None
    assert inspect(["keeper/src/fixtures/cboe-nvda-2026-09-14.json"], [], None, None)
    assert inspect(
        ["keeper/src/fixtures/cboe-nvda-2026-09-14.json"], [], None, None,
        deleted_paths=frozenset({"keeper/src/fixtures/cboe-nvda-2026-09-14.json"}),
    ) == []
    assert inspect(
        ["README.md"], [], None, None, deleted_paths=frozenset({"README.md"}),
    )
    assert path_problem("keeper/src/v2/pricing/cboe.test.ts") is None
    assert path_problem("ops/runbooks.test.mjs") == "test depends on withheld Markdown runbooks"
    for markdown in (
        "README.md", "web/README.MD", "docs/guide.mdx", "docs/guide.MDX", "notes.markdown",
        "docs/guide.mdown", "docs/guide.mkd", "docs/guide.mkdn", "docs/guide.mdwn",
        "docs/guide.mdtxt", "docs/guide.mdtext", "llms.txt", "docs/LLMS.TXT",
    ):
        assert path_problem(markdown) == "Markdown path change excluded from this code-only migration"
        assert inspect([markdown], [], None, None) == [
            f"{markdown}: Markdown path change excluded from this code-only migration"
        ]
    assert path_problem("web/.next/cache/preview.bin")
    assert path_problem("node_modules/pkg/index.js")
    assert path_problem("indexer/build/index.js")
    assert path_problem("web/.env.production")
    assert path_problem("ops/v2/env/cranker.env")
    assert path_problem("ops/keeper/markets/NVDA.env")
    assert path_problem("ops/v2/env/unexpected.env", frozenset({"ops/v2/env/cranker.env"}))
    assert path_problem("keys/operator.pem")
    assert inspect(["contracts"], [], None, "0" * 40)
    assert inspect(["contracts"], [], "1" * 40, "0" * 40)
    assert inspect(["contracts"], [], "0" * 40, "0" * 40) == []
    assert inspect([], ["/" + "Users" + "/alice/private/file"], None, None)
    assert inspect([], ["/private/" + "tmp" + "/assistant-run/file"], None, None)

    # Simulate index and working-tree snapshots without staging any real files.
    registry = json.dumps({"markets": [
        {"ticker": "NVDA", "status": "live"},
        {"ticker": "TSLA", "status": "superseded-by-v2"},
        {"ticker": "PAUSED", "status": "paused"},
    ]}).encode()
    allowlist = generated_env_allowlist(registry)
    assert "ops/v2/env/cranker.env" in allowlist
    assert "ops/keeper/markets/NVDA.env" in allowlist
    assert "ops/keeper/markets/TSLA.env" in allowlist
    assert "ops/keeper/markets/PAUSED.env" not in allowlist
    assert "ops/v2/env/unexpected.env" not in allowlist
    paths = ["ops/v2/env/cranker.env", "ops/keeper/markets/NVDA.env"]
    blobs = {
        REGISTRY: registry, V2_GENERATOR: b"v2 renderer", KEEPER_GENERATOR: b"keeper renderer",
        paths[0]: b"public v2 config", paths[1]: b"public keeper config",
    }
    approved, problems = validate_generated_envs(
        paths, blobs.get, blobs.get, lambda generator: generator in {V2_GENERATOR, KEEPER_GENERATOR},
    )
    assert approved == frozenset(paths) and not problems
    assert inspect(paths, [], None, None, approved) == []
    approved, problems = validate_generated_envs(
        paths, blobs.get, lambda path: b"different" if path == paths[0] else blobs.get(path),
        lambda generator: True,
    )
    assert not approved and problems == [f"{paths[0]}: staged bytes must match the working tree"]
    approved, problems = validate_generated_envs(
        paths, blobs.get, lambda path: b"different" if path == REGISTRY else blobs.get(path),
        lambda generator: True,
    )
    assert not approved and problems == ["generated env: staged registry must match the working tree"]
    approved, problems = validate_generated_envs(
        paths, blobs.get, lambda path: b"different" if path == V2_GENERATOR else blobs.get(path),
        lambda generator: True,
    )
    assert not approved and problems == [f"{V2_GENERATOR}: staged bytes must match the working tree"]
    approved, problems = validate_generated_envs(paths, blobs.get, blobs.get, lambda generator: False)
    assert not approved and len(problems) == 2
    approved, problems = validate_generated_envs(
        ["ops/keeper/markets/PAUSED.env"], blobs.get, blobs.get, lambda generator: True,
    )
    assert not approved and not problems
    assert inspect(["ops/keeper/markets/PAUSED.env"], [], None, None, approved)
    try:
        generated_env_allowlist(json.dumps({"markets": [{"ticker": "../BAD", "status": "live"}]}).encode())
        raise AssertionError("invalid registry ticker accepted")
    except ValueError:
        pass
    print("scope guard self-test: pass (positive and negative cases)")
    return 0


def staged_paths() -> list[str]:
    # Include deletions, and turn renames into their old-path deletion plus
    # new-path addition so a Markdown -> non-Markdown rename cannot slip past.
    raw = git(
        "diff", "--cached", "--name-only", "--diff-filter=ACDMRT",
        "--no-renames", "-z", "--no-ext-diff",
    )
    return [part.decode("utf-8", errors="replace") for part in raw.split(b"\0") if part]


def staged_deletions() -> frozenset[str]:
    raw = git(
        "diff", "--cached", "--name-only", "--diff-filter=D",
        "--no-renames", "-z", "--no-ext-diff",
    )
    return frozenset(part.decode("utf-8", errors="replace") for part in raw.split(b"\0") if part)


def staged_added_lines() -> list[str]:
    diff = git("diff", "--cached", "--unified=0", "--no-ext-diff", "--no-color", "--")
    return [
        line[1:].decode("utf-8", errors="replace")
        for line in diff.splitlines()
        if line.startswith(b"+") and not line.startswith(b"+++")
    ]


def staged_contracts_pin() -> str | None:
    raw = git("ls-files", "--stage", "--", "contracts").decode("ascii", errors="replace")
    match = re.fullmatch(r"160000 ([0-9a-f]{40}) 0\tcontracts\n?", raw)
    return match.group(1) if match else None


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    if len(sys.argv) > 1:
        print("usage: precommit-scope-guard.py [--self-test]", file=sys.stderr)
        return 2

    try:
        paths = staged_paths()
        git("diff", "--cached", "--check", "--")
        if not paths:
            print("scope guard: no staged additions or modifications")
            return 0
        pin = staged_contracts_pin() if "contracts" in paths else None
        approved_envs, env_problems = validate_generated_envs(paths)
        problems = env_problems + inspect(
            paths,
            staged_added_lines(),
            os.environ.get("CALLHOUSE_APPROVED_PUBLIC_CONTRACTS_PIN"),
            pin,
            approved_envs,
            staged_deletions(),
        )
    except (OSError, subprocess.CalledProcessError):
        print("scope guard: could not inspect staged Git content", file=sys.stderr)
        return 2

    for problem in problems:
        print(f"scope guard: {problem}", file=sys.stderr)
    if problems:
        return 1
    print(f"scope guard: checked {len(paths)} staged paths")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
