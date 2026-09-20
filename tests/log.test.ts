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
    expect(redactPath("/b2/groups")).toBe("/b2/groups");
    expect(redactPath("/b2/threads")).toBe("/b2/threads");
    expect(redactPath("/v1/boot/version")).toBe("/v1/boot/version");
  });

  it("does not redact the b3 action verb after /users/ (it's not an id)", () => {
    expect(redactPath("/b3/users/deactivate?id=42&b3_api_key=hunter2")).toBe(
      "/b3/users/deactivate",
    );
    expect(redactPath("/b3/users/reactivate")).toBe("/b3/users/reactivate");
  });

  it("redacts the user id in the b3 MEMBER routes while keeping the action verb", () => {
    expect(redactPath("/b3/users/42/deactivate")).toBe("/b3/users/:id/deactivate");
    expect(redactPath("/b3/users/4242/reactivate?x=1")).toBe("/b3/users/:id/reactivate");
    expect(redactPath("/b3/users/42")).toBe("/b3/users/:id");
  });

  it("redacts group ids, keys AND handles after /groups/", () => {
    expect(redactPath("/b2/groups/7")).toBe("/b2/groups/:id");
    expect(redactPath("/v1/groups/7")).toBe("/v1/groups/:id");
    expect(redactPath("/b2/groups/abcDEF12")).toBe("/b2/groups/:id");
    expect(redactPath("/b2/groups/my-team-handle")).toBe("/b2/groups/:id");
  });

  it("redacts thread ids and keys after /threads/, keeping the member action", () => {
    expect(redactPath("/b2/threads/12")).toBe("/b2/threads/:id");
    expect(redactPath("/b2/threads/12/items?from=0&per=50")).toBe("/b2/threads/:id/items");
    expect(redactPath("/b2/threads/abcDEF12/markdown")).toBe("/b2/threads/:id/markdown");
  });
});
