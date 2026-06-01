import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, validateCastText } from "./farcaster";

describe("validateCastText", () => {
  it("requires non-empty text", () => {
    expect(validateCastText("   ").valid).toBe(false);
  });

  it("accepts normal cast text", () => {
    expect(validateCastText("gm hypersnap").valid).toBe(true);
  });
});

describe("hex helpers", () => {
  it("round trips bytes", () => {
    const bytes = new Uint8Array([1, 2, 255]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });
});
