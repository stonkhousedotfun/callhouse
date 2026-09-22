import schema from "ponder:schema";

import { makerEpoch, makerEpochId, reduceTier } from "../../lib/v2/makerRegistry";
import { MAKER_BENCHMARK_POLICY } from "../../lib/v2/makerScoring";
import { v2Ponder as ponder } from "../../lib/registry";

ponder.on("MakerRegistry:TierSet", async ({ event, context }) => {
  const { maker, rebateBps } = event.args;
  const epoch = makerEpoch(event.block.timestamp);
  const id = makerEpochId(maker, epoch);
  const current = await context.db.find(schema.v2MakerEpoch, { id });
  if (current === null) {
    await context.db.insert(schema.v2MakerEpoch).values({
      id,
      maker: maker.toLowerCase() as typeof maker,
      epoch,
      tierBps: reduceTier(0, rebateBps),
      // Scored later by this build, so under this build's benchmark (MAKER_BENCHMARK_POLICY).
      benchmarkPolicy: MAKER_BENCHMARK_POLICY,
    });
  } else {
    await context.db.update(schema.v2MakerEpoch, { id }).set({ tierBps: reduceTier(current.tierBps, rebateBps) });
  }
});
