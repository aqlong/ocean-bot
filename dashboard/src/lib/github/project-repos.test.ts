import { describe, it, expect, afterEach } from "vitest";
import { repoForProject } from "./project-repos";

const ORIG = process.env["OCEAN_BOT_PROJECT_REPOS"];

afterEach(() => {
  if (ORIG === undefined) delete process.env["OCEAN_BOT_PROJECT_REPOS"];
  else process.env["OCEAN_BOT_PROJECT_REPOS"] = ORIG;
});

describe("repoForProject", () => {
  it("returns the default for the code2wiki project", () => {
    delete process.env["OCEAN_BOT_PROJECT_REPOS"];
    expect(repoForProject("code2wiki")).toBe("craftandship/code2wiki");
  });

  it("returns null for unknown projects", () => {
    delete process.env["OCEAN_BOT_PROJECT_REPOS"];
    expect(repoForProject("nope")).toBeNull();
  });

  it("env override merges with defaults", () => {
    process.env["OCEAN_BOT_PROJECT_REPOS"] = "foo=acme/foo,bar=acme/bar";
    expect(repoForProject("foo")).toBe("acme/foo");
    expect(repoForProject("bar")).toBe("acme/bar");
    expect(repoForProject("code2wiki")).toBe("craftandship/code2wiki");
  });

  it("env override can replace a default mapping", () => {
    process.env["OCEAN_BOT_PROJECT_REPOS"] = "code2wiki=fork/code2wiki";
    expect(repoForProject("code2wiki")).toBe("fork/code2wiki");
  });

  it("ignores malformed pairs", () => {
    process.env["OCEAN_BOT_PROJECT_REPOS"] = "valid=acme/valid,bogus,nope=onlyone";
    expect(repoForProject("valid")).toBe("acme/valid");
    expect(repoForProject("bogus")).toBeNull();
    expect(repoForProject("nope")).toBeNull();
  });
});
