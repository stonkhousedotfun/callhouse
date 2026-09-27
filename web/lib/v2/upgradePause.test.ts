import { describe, expect, it } from "vitest";

import { depositDoor, pausedForUpgrade, UPGRADE_PAUSE_NOTE, UPGRADE_PAUSE_UNREAD_NOTE } from "./upgradePause";

const brakes = (tradingPaused: boolean, mintPaused: boolean) => ({ tradingPaused, mintPaused });

/**
 * The three deposit doors (Clearinghouse.deposit, HouseVault.requestDeposit, EarnVault.deposit) close only
 * when the chain says the WHOLE deployment is paused: the book's trading brake AND every market's mint brake.
 */
describe("pausedForUpgrade", () => {
  it("is a pause only when trading and every market's mint are paused", () => {
    expect(pausedForUpgrade([brakes(true, true)])).toBe(true);
    expect(pausedForUpgrade([brakes(true, true), brakes(true, true)])).toBe(true);
  });

  it("one market's mint brake is not an upgrade pause, even with trading paused", () => {
    expect(pausedForUpgrade([brakes(true, true), brakes(true, false)])).toBe(false);
    expect(pausedForUpgrade([brakes(true, false)])).toBe(false);
  });

  it("every mint paused with trading open is not an upgrade pause", () => {
    expect(pausedForUpgrade([brakes(false, true), brakes(false, true)])).toBe(false);
  });

  it("an unread, failed or empty market list is not a SERVED pause (depositDoor decides what unknown means)", () => {
    expect(pausedForUpgrade(undefined)).toBe(false);
    expect(pausedForUpgrade(null)).toBe(false);
    expect(pausedForUpgrade([])).toBe(false);
  });
});

describe("depositDoor", () => {
  const paused = [brakes(true, true), brakes(true, true)];
  const live = [brakes(false, false), brakes(false, false)];

  it("paused: a ready door is closed and says why", () => {
    expect(depositDoor(true, paused)).toEqual({ open: false, note: UPGRADE_PAUSE_NOTE });
  });

  it("unpaused: a ready door is open with no note, exactly as before", () => {
    expect(depositDoor(true, live)).toEqual({ open: true, note: null });
  });

  // These replace `depositDoor(true, undefined)` -> open, which pinned the failed-read-opens-the-door
  // behaviour this removes: the chain may be paused, and nothing else stops the deposit. `ready` is true in each
  // case, so the market-list argument is the only thing that can shut the door.
  it("a FAILED market read (null) keeps a ready door shut and says why", () => {
    expect(depositDoor(true, null)).toEqual({ open: false, note: UPGRADE_PAUSE_UNREAD_NOTE });
    expect(depositDoor(false, null)).toEqual({ open: false, note: UPGRADE_PAUSE_UNREAD_NOTE });
  });

  it("a market read not answered yet (undefined) keeps a ready door shut, with nothing to say yet", () => {
    expect(depositDoor(true, undefined)).toEqual({ open: false, note: null });
  });

  it("a served EMPTY market list is not a pause: a ready door stays open", () => {
    expect(depositDoor(true, [])).toEqual({ open: true, note: null });
  });

  it("never opens a door its own gate keeps shut", () => {
    expect(depositDoor(false, live)).toEqual({ open: false, note: null });
    expect(depositDoor(false, paused)).toEqual({ open: false, note: UPGRADE_PAUSE_NOTE });
  });

  it("the note says the door is paused for an upgrade and that leaving still works", () => {
    expect(UPGRADE_PAUSE_NOTE).toMatch(/^Paused for upgrade\./);
    expect(UPGRADE_PAUSE_NOTE).toMatch(/withdrawals stay open/);
    expect(UPGRADE_PAUSE_UNREAD_NOTE).toMatch(/^Could not check whether deposits are paused/);
    expect(UPGRADE_PAUSE_UNREAD_NOTE).toMatch(/withdrawals stay open/);
  });
});
