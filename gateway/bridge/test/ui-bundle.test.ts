import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("bridge bundle", () => {
  it("check:bundle passes on the real bundle and the html has no inline script or style", () => {
    execFileSync("npm", ["run", "build"], { stdio: "pipe" });
    execFileSync("npm", ["run", "check:bundle"], { stdio: "pipe" });
    const html = readFileSync("dist/index.html", "utf8");
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).toMatch(/<script\b[^>]*\bsrc="\/bridge\/assets\/bridge-[a-f0-9]{8}\.js"[^>]*>\s*<\/script>/i);
    const source = readFileSync("index.html", "utf8");
    expect(source).not.toMatch(/<style\b/i);
    expect(source).not.toMatch(/\sstyle\s*=/i);
    expect(source).not.toMatch(/<script\b[^>]*>\s*[^<\s]/i);
  });
});
