# Security

This repository is the off-chain app, indexer, bots, notifier, relay and deployment tooling for
Stonkhouse. The private `v2` branch is integration work; code or seeded devnet addresses here do
not establish a v2 mainnet deployment. The public `origin/main` release and the v1 run-off have
separate state and owner-controlled release gates.

## Source of truth

- Verify that the committed `contracts/` submodule pin contains v2 before relying on the protocol threat model in
  [`contracts/SECURITY.md`](contracts/SECURITY.md), v2 accounting in
  [`contracts/docs/V2-ACCOUNTING.md`](contracts/docs/V2-ACCOUNTING.md), and the v2 architecture in
  [`contracts/docs/V2-ARCHITECTURE.md`](contracts/docs/V2-ARCHITECTURE.md). Initialize the submodule
  before relying on those links. An integration checkout that still pins v1 must not be used to
  infer v2 behavior. The older contract accounting and this
  repo's [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) describe v1.
- [`HANDOFF.md`](HANDOFF.md) maps the off-chain packages, generated ABIs, registry and gates.
  The deployment and incident procedures are in [`ops/deploy.md`](ops/deploy.md),
  [`ops/runbooks/incident-v2.md`](ops/runbooks/incident-v2.md), and
  [`ops/go-live-v2.sh`](ops/go-live-v2.sh).
- V2 contract addresses and market status come from `ops/markets/tier1.json` and verified
  deployment records. Local `ops/devnet/addresses.json` is never a production source.

## Trust boundaries

- Contracts settle balances and fees. The indexer is a replayable projection used for display;
  the app checks compiled deployment addresses, on-chain series terms, selected orders and live
  quotes before writes. A fee or quote can still change before a transaction is included, so
  transaction guards and the final receipt matter.
- Keeper keys have different permissions. The cranker performs lifecycle upkeep; the MM quoter
  and pricer can affect MakerVault orders and auto-roll pricing within their contract limits.
  Treat their keys, the contract admin and guardian roles, the fee recipient, oracle source
  configuration, and payout route configuration as separate authorities. See the pinned contract
  threat model for the exact powers at the deployed revision.
- The notifier stores encrypted destinations and accepts browser-supplied Web Push endpoints.
  Production ingress limits and outbound egress controls are deployment requirements; hostname
  syntax checks alone do not pin DNS.

## Reporting

Do not open a public issue for a vulnerability. Send it to **security@stonkhouse.fun**. The
public site also lists this contact at `https://stonkhouse.fun/.well-known/security.txt` and
`https://stonkhouse.fun/legal#reporting`.
