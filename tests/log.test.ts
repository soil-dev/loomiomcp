import { describe, it, expect } from "vitest";
import { redactPath } from "../src/log.js";

describe("redactPath", () => {
  it("strips the query string entirely (api_key MUST NOT leak)", () => {
    expect(redactPath("/b2/discussions/42?api_key=secret")).toBe("/b2/discussions/:id");
    expect(redactPath("/b2/polls?group_id=7&api_key=secret&status=open")).toBe("/b2/polls");
  });

  it("strips b3_api_key too", () => {
    expect(redactPath("/b3/users/deactivate?id=42&b3_api_key=hunter2")).toBe(
      "/b3/users/deactivate",
    );
  });

  it("replaces numeric id segments with :id", () => {
    expect(redactPath("/b2/discussions/254022621")).toBe("/b2/discussions/:id");
    expect(redactPath("/b2/discussions/254022621/comments/789")).toBe(
      "/b2/discussions/:id/comments/:id",
    );
  });

  it("replaces multi-id segments (comma-separated GETs) with :id", () => {
    expect(redactPath("/b2/discussions/1,2,3")).toBe("/b2/discussions/:id");
  });

  it("redacts non-numeric short keys after discussions/polls (Loomio's string ids like 'abcDEF12')", () => {
    expect(redactPath("/b2/polls/abcDEF12")).toBe("/b2/polls/:id");
    expect(redactPath("/b2/discussions/abcDEF12")).toBe("/b2/discussions/:id");
    expect(redactPath("/b2/discussions/abc/comments/123")).toBe("/b2/discussions/:id/comments/:id");
  });

  it("leaves bare paths unchanged", () => {
    expect(redactPath("/b2/memberships")).toBe("/b2/memberships");
  });

  it("does not redact the b3 action verb after /users/ (it's not an id)", () => {
    expect(redactPath("/b3/users/deactivate?id=42&b3_api_key=hunter2")).toBe(
      "/b3/users/deactivate",
    );
    expect(redactPath("/b3/users/reactivate")).toBe("/b3/users/reactivate");
  });
});
