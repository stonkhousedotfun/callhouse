# Runbook — Close the legal perimeter

**What this is.** The list of decisions a lawyer has to make before the legal pages stop saying
"not yet designated", the exact variables those decisions turn into, and the order to apply them
in. It exists because the 2026-09-12 readiness audit found the perimeter was a sentence pointing
at nothing: `/legal` said access was restricted "by the terms you accept here" and there were no
terms, no privacy notice, no disclosure address and no legal person behind the fee Safe.

**Who runs it.** Counsel makes the decisions in §2. Whoever has write access to the Railway
project applies §3 and §4. Nothing here touches a key or moves a token.

**Nothing in this file is legal advice.** It was written by engineers to make the gaps visible
and to make closing them a mechanical step once a lawyer has decided. Where it names an option it
is describing what the code can do, not recommending a position.

**Time budget.** Unknown — it is gated on counsel. The engineering half (§3–§4) is twenty minutes
plus two rebuilds.

---

## 0. The shape of it

```
site/lib/legal.ts             one constant per operator fact, read from NEXT_PUBLIC_*, no defaults
site/app/terms/page.tsx       Terms of Use, DRAFT, renders the gaps
site/app/privacy/page.tsx     Privacy notice, DRAFT, renders the gaps
site/app/legal/page.tsx       links /terms; "Reporting a vulnerability" section at #reporting
site/app/.well-known/security.txt/route.ts
                              RFC 9116; 404 until a security contact exists
web/lib/site.ts               TERMS_URL / PRIVACY_URL, links into the site; nothing duplicated
SECURITY.md §6                points at security.txt and says it is unset
```

The pages are deliberately published in their unfinished state. Every unset fact renders as
**not yet designated**, in words, on the page, and both drafts carry a warn notice while
`operatorIsDesignated()` is false. This product publishes an unfilled week as "unfilled, 0"; the
operator line gets the same treatment. Do not "fix" a notice by filling a variable with a
placeholder.

---

## 1. What exists today

| Thing | State | Where |
|---|---|---|
| Terms of Use | drafted, not adopted, marked "Draft — pending review by counsel" top and bottom | `callhouse.xyz/terms` |
| Privacy notice | drafted from the code, not adopted, same markers | `callhouse.xyz/privacy` |
| Perimeter disclosure | live since before this runbook; now links the terms instead of "the terms you accept here" | `callhouse.xyz/legal`, `app.callhouse.xyz/legal` |
| Vulnerability reporting | section exists, address unset | `callhouse.xyz/legal#reporting` |
| `security.txt` | route exists, returns **404** with a one-line explanation until the contact is set | `callhouse.xyz/.well-known/security.txt` |
| Operator constants | six, all `undefined` | `site/lib/legal.ts` |
| Document version | `draft-2026-09-12` | `LEGAL_DOCS_VERSION` in `site/lib/legal.ts` |
| Accept flow | none. Use is acceptance; the pages say so | — |
| Geoblock | none. The US-person perimeter is disclosure-only, on every legal page, in bold | — |
| Cookies / analytics | none on either domain, verified by grep and stated on `/privacy` | — |

What the privacy notice says the system does is grounded file by file in the header comment of
`site/app/privacy/page.tsx`. If counsel wants a sentence changed, check that comment first: the
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
   `site/app/legal/page.tsx` explains why a checkbox would imply a control that does not exist.
   Decide whether disclosure is sufficient or whether a technical control is required. A
   technical control is a product change and a runtime dependency, not a variable.
   → no variable; a decision that either closes the item or opens a task

8. **Contacts.** Three mailboxes: legal notices, data-protection requests, vulnerability
   reports. They may be the same address. Each must be a mailbox somebody reads, because the
   pages will publish it, `security.txt` will advertise it to scanners, and an unread disclosure
   mailbox is worse than the current 404.
   → `NEXT_PUBLIC_LEGAL_CONTACT_EMAIL`, `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`,
     `NEXT_PUBLIC_SECURITY_CONTACT_EMAIL`

9. **Adoption.** When the text of `/terms` and `/privacy` is what counsel wants, the draft
   markers come off by changing `LEGAL_DOCS_VERSION` in `site/lib/legal.ts` from
   `draft-YYYY-MM-DD` to a value without the `draft-` prefix, e.g. `v1-2026-10-01`. That is a
   code change, reviewed like any other. `scripts/copy-lint.mjs` requires the literal
   `export const LEGAL_DOCS_VERSION = "draft-` in `site/lib/legal.ts`, so dropping the prefix fails CI until
   that REQUIRED entry is removed in the same commit — which is the intended reminder. (The
   two "Draft" entries for the pages only prove the marker code is still there; they may stay.)
   → `LEGAL_DOCS_VERSION` (code, not env)

---

## 3. The variables

All six are `NEXT_PUBLIC_*`, read by `site/lib/legal.ts`, and therefore **inlined at build time**
into the `site` service only. `web` reads none of them; it links to the site's pages.

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
the edge: with the name and only the security contact set, both drafts drop the notice while
`/terms` Contact and `/privacy` Contact still read "not yet designated". That is accepted, not
hidden — the gap is still printed inline — but set all three contacts in one go so it never
shows.

**`site/Dockerfile` does not yet declare these as build ARGs.** As of 2026-09-12 it declares only
`NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_APP_URL`, and a Railway service variable reaches a
Dockerfile build only through a declared `ARG` (`ops/deploy.md` §3). Setting the six on Railway
today builds a site that still says "not yet designated". Before §4 step 2, add six `ARG`/`ENV`
pairs to `site/Dockerfile`, in the build-time configuration block, with **no default values** —
the whole point is that an absent value renders the gap. That edit was outside the scope of the
change that created this runbook and is still open.

---

## 4. Order of operations

Do these in order. Step 1 is the long one and it is not ours.

1. **Decide.** Counsel closes every item in §2 that becomes a variable, and answers items 3, 5
   and 7 in writing so the answer is on record even when it is "the current behaviour stands".

2. **Declare the ARGs.** Add the six `ARG`/`ENV` pairs to `site/Dockerfile` (see §3). Merge.

3. **Set the variables** on the Railway `site` service. All six, exactly as they should read on
   the page. Then **rebuild** `site` — Railway → service → Deploy → Redeploy, or push a commit. A
   restart does nothing; the values are compiled in.

4. **Rebuild `web` too.** It has no new variable, but it links to `${NEXT_PUBLIC_SITE_URL}/terms`
   and `/privacy`, and the footer links and the `/legal` link only exist in builds after
   2026-09-12. If `web` was last built before that, rebuild it now so both domains carry the
   links in the same window.

5. **Verify the notice is gone.**

   ```bash
   # Both drafts still carry the draft marker (until §2 item 9) but the operator gap is closed:
   curl -s https://callhouse.xyz/terms   | grep -c 'not yet designated'     # 0
   curl -s https://callhouse.xyz/privacy | grep -c 'not yet designated'     # 0
   curl -s https://callhouse.xyz/terms   | grep -c 'No operating entity'    # 0
   curl -s https://callhouse.xyz/legal   | grep -c 'not yet designated'     # 0
   ```

   A non-zero count means the variable did not reach the build: check the `ARG` from step 2,
   then that the rebuild actually ran (`ops/deploy.md` §9 item 1).

6. **Verify `security.txt` returns 200** and has a real contact line.

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://callhouse.xyz/.well-known/security.txt   # 200
   curl -s https://callhouse.xyz/.well-known/security.txt
   # Contact: mailto:<the address>
   # Expires: <LEGAL_DOCS_VERSION date + 1 year>
   # Preferred-Languages: en
   # Canonical: https://callhouse.xyz/.well-known/security.txt
   # Policy: https://callhouse.xyz/legal#reporting
   ```

   The `Expires:` line is one year after the date in `LEGAL_DOCS_VERSION`. When the documents
   are next reviewed, bump the version and the expiry moves with it; when they are not, the file
   expires on its own, which is what RFC 9116 wants.

7. **Update `SECURITY.md` §6** to drop the sentence saying the address is unset. Same commit as
   the version bump in §2 item 9 if they land together.

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
- Anything on `app.callhouse.xyz` beyond the links. The dapp carries the perimeter disclosure
  and links out; every operator fact renders on the site once.

## Related

| File | What it covers |
|---|---|
| `site/lib/legal.ts` | the six constants, `operatorIsDesignated()`, `LEGAL_DOCS_VERSION` |
| `site/.env.example` | the same six, documented as build-time |
| `ops/deploy.md` | why `NEXT_PUBLIC_*` needs a rebuild and a Dockerfile `ARG` |
| `SECURITY.md` §6 | the reporting paragraph that points here |
| `scripts/copy-lint.mjs` | the CI gate that fails on adoption (`draft-` prefix) until its REQUIRED entry is removed |
