import { describe, expect, it } from "vitest";
import { normalizeBaseUrl } from "./hypersnap";

describe("normalizeBaseUrl", () => {
  it("removes trailing slashes without changing the host", () => {
    expect(normalizeBaseUrl("https://haatz.quilibrium.com///")).toBe(
      "https://haatz.quilibrium.com",
    );
  });
});
