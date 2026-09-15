# Security

The threat model, the properties the contracts enforce, what a compromise of each key buys, and
the record of what the 2026-09-12 adversarial review found now live with the contracts, in
**[`contracts/SECURITY.md`](contracts/SECURITY.md)** (repository `stonkhousedotfun/callhouse-contracts`,
mounted here as a git submodule at `contracts/`). Run `git submodule update --init --recursive`
if that link is empty.

This repository holds the off-chain half: the keeper (one hot key that can propose a roll but can
never move a token), the indexer, and the dapp at `app.stonkhouse.fun`. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §2 for the trust boundaries,
[`contracts/docs/ACCOUNTING.md`](contracts/docs/ACCOUNTING.md) for the money maths, and
`ops/alerts.md` for the per-alert response runbooks.

## Reporting

If you believe you have found a vulnerability, do not open a public issue. Send it to
**security@stonkhouse.fun**. The same address is published, machine-readably, at
`https://stonkhouse.fun/.well-known/security.txt` (RFC 9116) and on
`https://stonkhouse.fun/legal#reporting`. Both read `NEXT_PUBLIC_SECURITY_CONTACT_EMAIL` from
`lib/legal.ts` in the landing repository, `stonkhousedotfun/callhouse-site`; the variable was set and the
site rebuilt on 2026-09-13, and the mailbox is a Cloudflare Email Routing forward to the
operator.

A bug bounty with a dedicated disclosure channel opens in mainnet week 2. Until
then the contracts are unaudited and a report is a favour, not a claim.
