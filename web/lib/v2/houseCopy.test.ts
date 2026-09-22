import { describe, expect, it } from "vitest";

import {
  HOUSE_DISCLOSURE_BOT_QUOTES,
  HOUSE_DISCLOSURE_CAN_LOSE,
  HOUSE_DISCLOSURE_PER_EPOCH_FACTS,
  HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS,
  HOUSE_DISCLOSURES,
} from "./houseCopy";

describe("house disclosures", () => {
  it("exports four non-empty strings covering the required facts", () => {
    expect(HOUSE_DISCLOSURES).toHaveLength(4);
    for (const text of HOUSE_DISCLOSURES) {
      expect(text.trim().length).toBeGreaterThan(20);
    }
    expect(HOUSE_DISCLOSURE_CAN_LOSE.toLowerCase()).toContain("lose money");
    expect(HOUSE_DISCLOSURE_BOT_QUOTES.toLowerCase()).toMatch(/bot[\s\S]*quot/);
    expect(HOUSE_DISCLOSURE_BOT_QUOTES.toLowerCase()).toContain("on chain");
    expect(HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS.toLowerCase()).toContain("once a week");
    expect(HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS.toLowerCase()).toContain("boundary");
    expect(HOUSE_DISCLOSURE_PER_EPOCH_FACTS.toLowerCase()).toContain("each epoch");
    expect(HOUSE_DISCLOSURE_PER_EPOCH_FACTS.toLowerCase()).toContain("lost money");
  });

  /**
   * THE NO-RATE RULE IS GONE, BY OWNER DECISION (plan section 5.4, W5). The word detector that used
   * to live here -- and the copy-lint script that ran the same table over the repo -- were removed
   * together, because the owner directed that the interest percentage BE SHOWN. A rule forbidding
   * "a percentage per unit of time" cannot coexist with a requirement to publish one.
   *
   * WHAT SURVIVES, AND WHY IT IS NOT THIS. `houseEpoch.ts` still returns NAV_NOT_AVAILABLE for a
   * running epoch (section 5.4.1). That is deliberately NOT in this row's fence and is a different
   * class of thing: removing it does not permit a forbidden word, it produces a WRONG NUMBER
   * RENDERED AS A RIGHT ONE. The decision that loosened the wording does not reach it.
   *
   * The four facts below are still asserted. They are product facts, not linter output.
   */
  it("still states the four facts, which no copy rule was ever what made them true", () => {
    expect(HOUSE_DISCLOSURES.join(" ")).toContain("lose money");
    expect(HOUSE_DISCLOSURES.join(" ")).toContain("paid in kind");
  });
});
