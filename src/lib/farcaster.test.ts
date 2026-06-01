import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  encodeCastAddMessageData,
  encodeSignedCastAddMessage,
  hexToBytes,
  toFarcasterTime,
  validateCastText,
} from "./farcaster";

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

describe("Farcaster encoding", () => {
  it("converts wall time to Farcaster time", () => {
    expect(toFarcasterTime(1609459200000 + 12_000)).toBe(12);
  });

  it("encodes cast add message data like the Farcaster protobuf", () => {
    expect(
      bytesToHex(
        encodeCastAddMessageData({
          fid: 1,
          timestamp: 1,
          text: "hello",
        }),
      ),
    ).toBe("0x08011001180120012a0b1200220568656c6c6f2a00");
  });

  it("encodes signed cast add messages like the Farcaster protobuf", () => {
    const dataBytes = encodeCastAddMessageData({
      fid: 123,
      timestamp: 456,
      text: "hello hypersnap",
      parentUrl: "chain://castora",
    });
    const hash = new Uint8Array(Array.from({ length: 20 }, (_, index) => index + 1));
    const signature = new Uint8Array(
      Array.from({ length: 64 }, (_, index) => 255 - index),
    );
    const signer = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));

    expect(bytesToHex(encodeSignedCastAddMessage({ dataBytes, hash, signature, signer }))).toBe(
      "0x0a310801107b18c80320012a2612003a0f636861696e3a2f2f636173746f7261220f68656c6c6f206879706572736e61702a0012140102030405060708090a0b0c0d0e0f101112131418012240fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0efeeedecebeae9e8e7e6e5e4e3e2e1e0dfdedddcdbdad9d8d7d6d5d4d3d2d1d0cfcecdcccbcac9c8c7c6c5c4c3c2c1c028013220000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f3a310801107b18c80320012a2612003a0f636861696e3a2f2f636173746f7261220f68656c6c6f206879706572736e61702a00",
    );
  });
});
