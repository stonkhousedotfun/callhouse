import { readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import vitestConfig from "../vitest.config";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globRegExp(pattern: string): RegExp {
  let source = "^";

  for (let index = 0; index < pattern.length;) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
      continue;
    }

    const character = pattern[index];
    if (character === "*") {
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    if (character === "{") {
      const closingBrace = pattern.indexOf("}", index + 1);
      if (closingBrace !== -1) {
        const alternatives = pattern
          .slice(index + 1, closingBrace)
          .split(",")
          .map(escapeRegExp)
          .join("|");
        source += `(?:${alternatives})`;
        index = closingBrace + 1;
        continue;
      }
    }

    source += escapeRegExp(character);
    index += 1;
  }

  return new RegExp(`${source}$`);
}

function testFiles(relativeDirectory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(join(webRoot, relativeDirectory), { withFileTypes: true })) {
    const relativePath = posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...testFiles(relativePath));
    } else if (entry.isFile() && entry.name.includes(".test.")) {
      files.push(relativePath);
    }
  }

  return files;
}

describe("Vitest test collection", () => {
  it("collects every test file under lib and components", () => {
    const include = (vitestConfig as { test?: { include?: string[] } }).test?.include;
    if (!include) throw new Error("web/vitest.config.ts must declare test.include patterns");

    const matchers = include.map(globRegExp);
    const discovered = [
      ...testFiles("lib"),
      ...testFiles("components"),
    ].sort();
    const collected = discovered.filter((file) => matchers.some((matcher) => matcher.test(file)));
    const orphaned = discovered.filter((file) => !collected.includes(file));

    expect(
      collected,
      `Vitest include patterns orphan committed test files:\n${orphaned.join("\n")}`,
    ).toEqual(discovered);
  });
});
