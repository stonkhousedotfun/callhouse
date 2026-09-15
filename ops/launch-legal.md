# Runbook — Close the legal perimeter

**What this is.** The list of decisions a lawyer has to make before the legal pages stop saying
"not yet designated", the exact variables those decisions turn into, and the order to apply them
in. It exists because the 2026-09-12 readiness audit found the perimeter was a sentence pointing
at nothing: `/legal` said access was restricted "by the terms you accept here" and there were no
terms, no privacy notice, no disclosure address and no legal person behind the fee Safe.

**Who runs it.** Counsel makes the decisions in §2 — with one recorded exception: on 2026-09-13
the owner elected to adopt the terms and privacy notice without counsel, reviewed against the
code, with standard boilerplate added and no facts invented (item 9, and items 3 and 7 answered
as "the current behaviour stands"). Items 1, 2, 4, 5 and 8 remain open and still need counsel or
a real-world fact. Whoever has write access to the Railway project applies §3 and §4. Nothing
here touches a key or moves a token.

**Nothing in this file is legal advice.** It was written by engineers to make the gaps visible
and to make closing them a mechanical step once a lawyer has decided. Where it names an option it
is describing what the code can do, not recommending a position.

**Time budget.** Unknown — it is gated on counsel. The engineering half (§3–§4) is twenty minutes
plus two rebuilds.

---

## 0. The shape of it

```
leekzor/callhouse-site (the landing's own repository):
lib/legal.ts                  one constant per operator fact, read from NEXT_PUBLIC_*, no defaults
app/terms/page.tsx            Terms of Use, adopted v1-2026-09-13, renders the gaps
app/privacy/page.tsx          Privacy notice, adopted v1-2026-09-13, renders the gaps
app/legal/page.tsx            links /terms; "Reporting a vulnerability" section at #reporting
app/.well-known/security.txt/route.ts
                              RFC 9116; 404 until a security contact exists

this repository (leekzor/callhouse):
web/lib/site.ts               TERMS_URL / PRIVACY_URL, links into the site; nothing duplicated
SECURITY.md "Reporting"       points at security.txt and says it is unset

leekzor/callhouse-contracts (the contracts/ submodule here):
SECURITY.md §6                the same reporting paragraph, carried with the threat model
```

The pages are deliberately published in their unfinished state. Every unset fact renders as
**not yet designated**, in words, on the page, and both legal documents carry a warn notice while
`operatorIsDesignated()` is false. This product publishes an unfilled week as "unfilled, 0"; the
operator line gets the same treatment. Do not "fix" a notice by filling a variable with a
placeholder.

---

## 1. What exists today

| Thing | State | Where |
|---|---|---|
| Terms of Use | adopted v1-2026-09-13 by owner decision, no counsel; corrected v2-2026-09-13; gap sentences still render | `stonkhouse.fun/terms` |
| Privacy notice | adopted v1-2026-09-13, same basis | `stonkhouse.fun/privacy` |
| Perimeter disclosure | live since before this runbook; now links the terms instead of "the terms you accept here" | `stonkhouse.fun/legal`, `app.stonkhouse.fun/legal` |
| Vulnerability reporting | section exists; address set 2026-09-13 (`security@callhouse.finance`) | `stonkhouse.fun/legal#reporting` |
| `security.txt` | returns **200** since 2026-09-13, Contact line present | `stonkhouse.fun/.well-known/security.txt` |
| Operator constants | six; the three contacts are set, name / jurisdiction / governing law still `undefined` | `lib/legal.ts` (site repo) |
| Document version | `v3-2026-09-15` (v1 adopted 2026-09-13; v2 the same day corrects the Terms' third-party clause: an oracle pause stops writing and listing, not settlement; v3 on 2026-09-15 renames Callhouse to Stonkhouse and callhouse.finance to stonkhouse.fun, nothing else) | `LEGAL_DOCS_VERSION` in `lib/legal.ts` (site repo) |
| Accept flow | none. Use is acceptance; the pages say so | — |
| Geoblock | none. The US-person perimeter is disclosure-only, on every legal page, in bold | — |
| Cookies / analytics | none on either domain, verified by grep and stated on `/privacy` | — |

The states above were measured on `callhouse.finance`, the domain before the 2026-09-15 rename. On
`stonkhouse.fun` they are owed again: DNS and TLS, Email Routing for `legal@`, `privacy@` and
`security@`, the three contact variables on the Railway `site` service, and a rebuild.

What the privacy notice says the system does is grounded file by file in the header comment of
`app/privacy/page.tsx` in `leekzor/callhouse-site`. If counsel wants a sentence changed, check that comment first: the
sentence may be describing a fact rather than a policy.

---

## 2. What counsel must decide

Each item ends with the variable it becomes, or "no variable" when it is a text change.

1. **Entity and jurisdiction.** Which legal person operates the two domains and publishes the
   interface. Today there is none: the fee Safe receives 5% of every week's premium and no legal
   person owns that Safe. Decide the entity and where it is organised.
   → `NEXT_PUBLIC_OPERATOR_LEGAL_NAME`, `NEXT_PUBLIC_OPERATOR_JURISDICTION`

2. **Governing law and forum.** The terms currently say "Governing law: not yet designated". The
   variable is rendered verbatim, so word it as it should read on the page ("the laws of X" or
   "X law, and the courts of Y have exclusive jurisdiction").
   → `NEXT_PUBLIC_GOVERNING_LAW`

3. **Acceptance.** The terms are use-based: visiting the domain is use under the terms, and
   there is no checkbox because there is no account to attach one to. Decide whether that is
   defensible for a perimeter that excludes US persons, or whether an explicit accept step is
   required before the dapp connects a wallet. If the latter, that is a product change in `web/`
   and is not covered by any variable here.
   → no variable; a decision that either closes the item or opens a task

4. **GDPR / UK GDPR controller.** The privacy notice renders the controller from the entity name
   and says "not yet designated" until then. Decide who the controller is (presumably the entity
   from item 1), whether a data-protection officer is required, and whether an EU or UK
   representative is required given where the entity sits and who the visitors are. The notice
   currently says the representative question is undecided; if the answer is "one is needed",
   the page needs a sentence naming them, which is a text change.
   → `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`; representative / DPO lines are text changes

5. **The fee Safe's legal owner.** 5% of harvested premium (never strike proceeds) routes to a Safe (`ops/safes.md`).
   Decide which legal person it belongs to and whether that needs to be said on a page. Today no
   page mentions the Safe's owner because there is nothing true to say.
   → no variable; possibly a text change on `/legal`

6. **Cookies and analytics.** There are none, and `/privacy` says so. If that ever changes — a
   consent banner, a metrics script, an error tracker — `/privacy` must change in the same
   commit and this decision reopens. Recorded here so the stance is a decision, not an accident.
   → no variable

7. **Geoblocking.** The "not available to US persons" perimeter is disclosure-only. There is no
   IP check, no wallet screening, and no country gate on either domain; the copy says so and
   `app/legal/page.tsx` (site repo) explains why a checkbox would imply a control that does not
   exist. Decide whether disclosure is sufficient or whether a technical control is required. A
   technical control is a product change and a runtime dependency, not a variable.
   → no variable; a decision that either closes the item or opens a task

8. **Contacts.** Done 2026-09-13: three mailboxes — `legal@`, `privacy@`,
   `security@callhouse.finance` — created with Cloudflare Email Routing, all forwarding to the
   owner's verified mailbox, and set on the Railway `site` service (then rebuilt, since the
   values are compiled in). Still owed: one external test email to each, and reading what
   arrives.
   → `NEXT_PUBLIC_LEGAL_CONTACT_EMAIL`, `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`,
     `NEXT_PUBLIC_SECURITY_CONTACT_EMAIL` (all three set)

9. **Adoption.** Done 2026-09-13: `LEGAL_DOCS_VERSION` in `lib/legal.ts` (site repo) is
   `v1-2026-09-13` — no `draft-` prefix, and the copy-lint gate that pinned it was removed in
   the same commit, as designed. Adopted by the owner without counsel; the operator, governing
   law and contact gaps are still rendered in words until items 1, 2 and 8 are decided. The two
   "Draft" REQUIRED entries for the pages stayed, as planned — they only prove the marker code
   is still there for a future draft revision.
   → `LEGAL_DOCS_VERSION` (code, not env)

---

## 3. The variables

All six are `NEXT_PUBLIC_*`, read by `lib/legal.ts` in the site repo, and therefore **inlined at
build time** into the `site` service only. `web` reads none of them; it links to the site's pages.

| Variable | Rendered where | If unset |
|---|---|---|
| `NEXT_PUBLIC_OPERATOR_LEGAL_NAME` | `/terms` Contact, `/privacy` Controller | "not yet designated"; warn notice on both pages |
| `NEXT_PUBLIC_OPERATOR_JURISDICTION` | after the name, in brackets | omitted |
| `NEXT_PUBLIC_GOVERNING_LAW` | `/terms` Governing law | "not yet designated" |
| `NEXT_PUBLIC_LEGAL_CONTACT_EMAIL` | `/terms` Contact | "not yet designated" |
| `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL` | `/privacy` Contact | "not yet designated" |
| `NEXT_PUBLIC_SECURITY_CONTACT_EMAIL` | `/legal#reporting`, `security.txt` Contact | "not yet designated"; `security.txt` is 404 |

The warn notice clears when the legal name **and at least one** of the three contacts is set
(`operatorIsDesignated()`). A name with no mailbox, or a mailbox with no name, keeps it up. Note
the edge: with the name and only the security contact set, both documents drop the notice while
`/terms` Contact and `/privacy` Contact still read "not yet designated". That is accepted, not
hidden — the gap is still printed inline — but set all three contacts in one go so it never
shows.

**The site repo's `Dockerfile` declares all six as build ARGs** (done 2026-09-13, in the
build-time configuration block, with **no default values** — the whole point is that an absent
value renders the gap). A Railway service variable reaches a Dockerfile build only through a
declared `ARG` (`ops/deploy.md` §3), so until that edit landed, setting the six on Railway would
have built a site that still says "not yet designated". What remains is §4 from step 3 on.

---

## 4. Order of operations

Do these in order. Step 1 is the long one and it is not ours.

1. **Decide.** Counsel closes every item in §2 that becomes a variable, and answers items 3, 5
   and 7 in writing so the answer is on record even when it is "the current behaviour stands".

2. **Declare the ARGs.** Done 2026-09-13: the site repo's `Dockerfile` declares the six
   `ARG`/`ENV` pairs (see §3). Nothing left to merge for this step.

3. **Set the variables** on the Railway `site` service. All six, exactly as they should read on
   the page. Then **rebuild** `site` — Railway → service → Deploy → Redeploy, or push a commit. A
   restart does nothing; the values are compiled in. *Partially done 2026-09-13: the three
   contact variables are set and rebuilt in; the name, jurisdiction and governing-law variables
   wait on items 1, 2 and 4.*

4. **Rebuild `web` too.** It has no new variable, but it links to `${NEXT_PUBLIC_SITE_URL}/terms`
   and `/privacy`, and the footer links and the `/legal` link only exist in builds after
   2026-09-12. If `web` was last built before that, rebuild it now so both domains carry the
   links in the same window.

5. **Verify the notice is gone.** *Only meaningful once the name variable is set — the notice is
   up by design until then (`operatorIsDesignated()` wants a name AND at least one contact). The
   checks below are for that moment.*

   ```bash
   # The operator gap is closed (the draft marker is gone since adoption, §2 item 9):
   curl -s https://stonkhouse.fun/terms   | grep -c 'not yet designated'     # 0
   curl -s https://stonkhouse.fun/privacy | grep -c 'not yet designated'     # 0
   curl -s https://stonkhouse.fun/terms   | grep -c 'No operating entity'    # 0
   curl -s https://stonkhouse.fun/legal   | grep -c 'not yet designated'     # 0
   ```

   A non-zero count means the variable did not reach the build: check the `ARG` from step 2,
   then that the rebuild actually ran (`ops/deploy.md` §9 item 1).

6. **Verify `security.txt` returns 200** and has a real contact line. *Verified 2026-09-13 on
   the Railway host (pre-DNS): 200 with `Contact: mailto:security@callhouse.finance` and
   `Expires: 2027-09-13`. Re-run on `stonkhouse.fun` once DNS resolves.*

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://stonkhouse.fun/.well-known/security.txt   # 200
   curl -s https://stonkhouse.fun/.well-known/security.txt
   # Contact: mailto:<the address>
   # Expires: <LEGAL_DOCS_VERSION date + 1 year>
   # Preferred-Languages: en
   # Canonical: https://stonkhouse.fun/.well-known/security.txt
   # Policy: https://stonkhouse.fun/legal#reporting
   ```

   The `Expires:` line is one year after the date in `LEGAL_DOCS_VERSION`. When the documents
   are next reviewed, bump the version and the expiry moves with it; when they are not, the file
   expires on its own, which is what RFC 9116 wants.

7. **Update the reporting paragraph in both places** to drop the sentence saying the address is
   unset. *Done 2026-09-13, paired: this repository's `SECURITY.md` "Reporting" and
   `contracts/SECURITY.md` §6 in leekzor/callhouse-contracts both now name
   `security@callhouse.finance`. On 2026-09-15 this repository's copy moved to
   `security@stonkhouse.fun`; the contracts copy still names the old address until a paired commit
   lands there.*

8. **Check the mailboxes.** Send one message to each of the three addresses from outside and
   confirm a human reads it. Then close the audit blocker.

---

## 5. What this runbook does not cover

- Whether the product is lawful to operate at all in the chosen jurisdiction. That is the
  question behind every item in §2 and it is entirely counsel's.
- The bug bounty's own disclosure channel (mainnet week 2, `tasks.md` E-07). `security.txt`
  points at the mailbox until that exists, then at whatever replaces it.
- The Stock Token issuer's terms. They govern whether a visitor may hold the collateral, and
  nothing on our pages widens or waives them (`/legal`).
- Anything on `app.stonkhouse.fun` beyond the links. The dapp carries the perimeter disclosure
  and links out; every operator fact renders on the site once.

## Related

| File | What it covers |
|---|---|
| `lib/legal.ts` (site repo) | the six constants, `operatorIsDesignated()`, `LEGAL_DOCS_VERSION` |
| `.env.example` (site repo) | the same six, documented as build-time |
| `ops/deploy.md` | why `NEXT_PUBLIC_*` needs a rebuild and a Dockerfile `ARG` |
| `SECURITY.md` "Reporting" | the reporting paragraph that points here |
| `contracts/SECURITY.md` §6 | the same paragraph in the contracts repo; change it with the one above |
| `scripts/copy-lint.mjs` (site repo) | the CI gate that pinned the `draft-` prefix until adoption; the entry was removed in the 2026-09-13 adoption commit |
