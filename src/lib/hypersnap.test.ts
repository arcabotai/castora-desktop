import { describe, expect, it } from "vitest";
import { isSignerRegistered, normalizeBaseUrl, normalizeSignerKey } from "./hypersnap";

describe("normalizeBaseUrl", () => {
  it("removes trailing slashes without changing the host", () => {
    expect(normalizeBaseUrl("https://haatz.quilibrium.com///")).toBe(
      "https://haatz.quilibrium.com",
    );
  });
});

describe("signer helpers", () => {
  it("normalizes signer keys with or without 0x", () => {
    expect(normalizeSignerKey("0xABCD")).toBe("abcd");
    expect(normalizeSignerKey("abcd")).toBe("abcd");
  });

  it("matches registered signer events", () => {
    expect(
      isSignerRegistered(
        [
          {
            fid: 1,
            signer_key: "abcd",
            key_type: 1,
            metadata_type: 1,
            block_number: 1,
            block_timestamp: 1,
          },
        ],
        "0xABCD",
      ),
    ).toBe(true);
  });
});
