/**
 * The v8 launch's two Safe-lane gates, as the AccessManager operation ids the countdown reads.
 *
 * Both stages were scheduled by the Admin Safe on 2026-09-22 (contracts 77674df3, run dir
 * broadcast/v8-launch/20260922T081126Z, day-zero/plan.json): `golive` enables the two launch markets on the
 * LISTING lane (1 h), `arm` names each House vault's protocol accounts on the CONFIG_ADMIN lane (24 h), which
 * arms {HouseVault.take} — the vault quotes nothing until then. The app never types a date: it reads
 * `AccessManager.getSchedule(opId)` (0 = not scheduled or already executed) and the effect itself
 * (`Clearinghouse.market(asset).enabled`, `HouseVault.protocolAccountsConfirmed()`), so a stage executed early,
 * late or cancelled shows as what it is.
 *
 * opId = keccak256(abi.encode(safe, target, data)) — copied from day-zero/plan.json, never recomputed here.
 */
import type { Hex } from "viem";

export const LAUNCH_GOLIVE_OPS: Readonly<Record<string, Hex>> = {
  NVDA: "0x2ea1119a2298322e9149be6986d96f1a8b38e543f3cfc6ce9933292831d9e125",
  SPCX: "0xa332fdf9177a44c1f42f85e2b3d7768b0c99074f4fa3089ecc1de4b6e357dec8",
};

/** Per vault: its three `setProtocolAccount(…, true)` operations; the first to execute arms the vault. */
export const LAUNCH_ARM_OPS: Readonly<Record<string, readonly Hex[]>> = {
  NVDA: [
    "0x5b60af8790f3ea34d8fa2ee1187885da34438c1b16b104add34b31fffee84f29",
    "0xea209795ca363d6bad1e783082f76d25e64cfad30d59bbc7ae25210312bd5e2e",
    "0x55e1973359eaa7c27e4a6e8f3272c51da50235ddd36a177ad62829feaf669928",
  ],
  SPCX: [
    "0xcb4ceccb61d023b99b7e88edc8e777f8b5fee505e6f4015ab1972274b81fa32f",
    "0x350ea250b2a5d25239301f645caff3f8f35dab493b28c41f8f459d106cd4f4f7",
    "0x375e9326d144dcb0307f552d16595c72ca001bb9a9a6867893beca294aa89730",
  ],
};
