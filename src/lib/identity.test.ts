import { describe, expect, it } from "vitest";
import {
  isLikelyEthAddress,
  normalizeEthAddress,
  toChecksumAddress,
} from "./identity";

describe("identity helpers", () => {
  it("normalizes Ethereum addresses", () => {
    expect(normalizeEthAddress("abc")).toBe("0xabc");
    expect(normalizeEthAddress("0xabc")).toBe("0xabc");
  });

  it("checks likely Ethereum address shape", () => {
    expect(isLikelyEthAddress("0x0000000000000000000000000000000000000000")).toBe(
      true,
    );
    expect(isLikelyEthAddress("0x1234")).toBe(false);
  });

  it("checksums Ethereum addresses", () => {
    expect(toChecksumAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toBe(
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    );
  });
});
