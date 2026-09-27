/**
 * The indexer's domain logger puts every finished line through redactUrls (./redact.ts), so a field that
 * carries an RPC URL with its key prints only the host. FAKE values only.
 *
 * Not covered here: Ponder's own logger (ponder/src/internal/logger.ts), which writes its RPC errors straight to
 * fd 1. Covers it in the image with the PID 1 wrapper ./stdio-redact.mjs, tested in stdio-redact.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { log } from "./log";

const KEYED = "https://robinhood-mainnet.g.alchemy.com/v2/FAKEKEY0123456789abcdef";
const BACKUP = "https://lb.drpc.live/ogrpc?network=robinhood&dkey=FAKEDKEY0123";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("log (lib/log.ts)", () => {
  it("an error carrying a keyed URL prints only the host, on both levels", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    vi.spyOn(console, "warn").mockImplementation((line: string) => void lines.push(line));
    const error = new Error(`HTTP request failed.\n\nURL: ${KEYED}\nRequest body: {"method":"eth_getLogs"}`);

    log.warn({ err: String(error), block: 69_512_673n }, "house vault read failed");
    log.info({ rpc: [KEYED, BACKUP] }, `synced through ${BACKUP}`);

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain("FAKE");
      JSON.parse(line);
    }
    const warn = JSON.parse(lines[0]!) as { level: string; err: string; block: string };
    expect(warn.level).toBe("warn");
    expect(warn.err).toContain("https://robinhood-mainnet.g.alchemy.com/…");
    expect(warn.block).toBe("69512673");
    const info = JSON.parse(lines[1]!) as { rpc: string[]; msg: string };
    expect(info.rpc).toEqual(["https://robinhood-mainnet.g.alchemy.com/…", "https://lb.drpc.live/…"]);
    expect(info.msg).toBe("synced through https://lb.drpc.live/…");
  });

  it("a bare origin and a line with no URL pass unchanged", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    log.info({ rpc: "https://rpc.mainnet.chain.robinhood.com", cycle: 7n }, "cycle opened");
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "info",
      service: "callhouse-indexer",
      msg: "cycle opened",
      rpc: "https://rpc.mainnet.chain.robinhood.com",
      cycle: "7",
    });
  });
});
