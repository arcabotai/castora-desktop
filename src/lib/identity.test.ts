import { describe, expect, it } from "vitest";
import {
  deriveCustodyAddressFromMnemonic,
  isLikelyEthAddress,
  normalizeEthAddress,
  normalizeMnemonic,
  toChecksumAddress,
} from "./identity";

describe("identity helpers", () => {
  it("normalizes mnemonic spacing and casing", () => {
    expect(normalizeMnemonic("  TEST   test\nJunk  ")).toBe("test test junk");
  });

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

  it("derives the first Ethereum account from a BIP39 mnemonic", async () => {
    const identity = await deriveCustodyAddressFromMnemonic(
      "test test test test test test test test test test test junk",
    );

    expect(identity.address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(identity.derivationPath).toBe("m/44'/60'/0'/0/0");
  });
});
