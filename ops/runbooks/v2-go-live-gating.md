# go-live-v2.sh service gating (O3-004)

`ops/v2/go-live-gating.mjs` is the single owner of these rules. `ops/go-live-v2.sh` applies them
before any Railway or key access.

| Rule | Effect |
|---|---|
| Relay required | `pricer`, `mm-bot`, `monitor` only |
| Relay exempt | `pricing`, `notifier`, `indexer-v2`, `cranker` |
| Signing refused on stonkhouse-dev | `cranker`, `pricer`, `mm-bot` (they hold `CRANKER_PK` / `PRICER_PK` / `MM_QUOTER_PK`). Monitor does not sign. They are omitted from the **dev** default service set so the documented dev invocation without `--services` plans instead of self-refusing. O8-05 also drops `cranker` and `pricer` from the **prod** default (`relay indexer-v2 pricing notifier monitor`). Always pass `--services`. |
| `MONITOR_HEALTH` | Built from **selected ∪ already-deployed** services that expose a health URL. Empty is refused when `monitor` is selected (never a silent skip). `--plan-gating` never queries Railway; pass `EXISTING_SERVICES` only in tests. |

Plan without Railway, network or secrets:

```bash
ops/go-live-v2.sh --plan-gating --services pricing,cranker
ops/go-live-v2.sh --plan-gating --project <stonkhouse-dev-id> --environment <dev-env-id> --services mm-bot
```

`--plan-gating` never runs `railway`, never reads `~/.callhouse-keys`, and is refused with `--apply`.
The default dry run still prints every Railway command `--apply` would run; use `--plan-gating` when
you only want the O3-004 decisions.
