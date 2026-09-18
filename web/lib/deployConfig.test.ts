import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const docker = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const env = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

describe("v2 browser configuration reaches a Docker build", () => {
  it.each(["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_V1_API_URL", "NEXT_PUBLIC_V2",
    "NEXT_PUBLIC_NOTIFIER_URL", "NEXT_PUBLIC_WC_PROJECT_ID"])("passes %s into next build", (key) => {
    expect(docker).toMatch(new RegExp(`^ARG ${key}=`, "m"));
    expect(docker).toMatch(new RegExp(`^ENV ${key}=\\$${key}$`, "m"));
    expect(env).toMatch(new RegExp(`^${key}=`, "m"));
  });
});
