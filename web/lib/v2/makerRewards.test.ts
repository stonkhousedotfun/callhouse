import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { makerClaimProofValid, parseMakerEpochFile } from "./makerRewards";

const reference = JSON.parse(readFileSync(fileURLToPath(
  new URL("../../../indexer/src/v2/fixtures/maker-epoch-2958.oz.json", import.meta.url)), "utf8"));

describe("published maker reward claims", () => {
  it("validates the independent OpenZeppelin vector and rejects its altered claim", () => {
    const file = parseMakerEpochFile(reference, 2958);
    expect(file.root).toBe("0xbaf77ffed3c63b4f37de4ac3510116b613e912df932c670f6ddba5bc78da6cb8");
    for (const entry of file.entries) expect(makerClaimProofValid(file, entry)).toBe(true);
    expect(makerClaimProofValid(file, reference.tampered)).toBe(false);
  });

  it("rejects wrong epochs, totals and duplicated beneficiaries before a wallet action", () => {
    expect(() => parseMakerEpochFile(reference, 2959)).toThrow();
    expect(() => parseMakerEpochFile({ ...reference, total: "1750002" }, 2958)).toThrow();
    const entries = structuredClone(reference.entries);
    entries[1].account = entries[0].account;
    expect(() => parseMakerEpochFile({ ...reference, entries }, 2958)).toThrow();
  });
});
