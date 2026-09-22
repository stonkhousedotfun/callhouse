import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/env", () => ({
  USDG: "0x0000000000000000000000000000000000000001",
  V2_MAKER_VAULT: undefined,
}));
vi.mock("./chain", () => ({ readMakerVaultState: vi.fn() }));

import { registerVaultRoutes } from "./vault";

describe("MakerVault route configuration", () => {
  it("returns an explicit not-configured response without making a live read", async () => {
    const app = new Hono();
    registerVaultRoutes(app);
    const response = await app.request("http://localhost/vault");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_configured", message: "MakerVault is not configured." },
    });
  });
});
