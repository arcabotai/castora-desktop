import { signMessageHash, submitSignedMessage } from "./tauri";

const FARCASTER_EPOCH_MS = 1609459200000;
const MAX_UINT32 = 2 ** 32 - 1;
const MESSAGE_TYPE_CAST_ADD = 1;
const FARCASTER_NETWORK_MAINNET = 1;
const HASH_SCHEME_BLAKE3 = 1;
const SIGNATURE_SCHEME_ED25519 = 1;

export type SignedCastAdd = {
  hashHex: string;
  signatureHex: string;
  signerHex: string;
  encodedMessageHex: string;
};

export function validateCastText(text: string) {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { valid: false, reason: "Write something before signing." };
  }

  if (trimmed.length > 320) {
    return { valid: false, reason: "Casts are limited to 320 characters for v1." };
  }

  return { valid: true, reason: "" };
}

export async function buildSignedCastAdd({
  fid,
  text,
  parentUrl,
}: {
  fid: number;
  text: string;
  parentUrl?: string;
}): Promise<SignedCastAdd> {
  const validation = validateCastText(text);

  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  const { blake3 } = await import("@noble/hashes/blake3");
  const dataBytes = encodeCastAddMessageData({
    fid,
    text: text.trim(),
    timestamp: toFarcasterTime(Date.now()),
    parentUrl,
  });
  const hash = blake3(dataBytes, { dkLen: 20 });
  const signature = await signMessageHash(fid, bytesToHex(hash));
  const signer = hexToBytes(signature.publicKeyHex);
  const encodedMessage = encodeSignedCastAddMessage({
    dataBytes,
    hash,
    signature: hexToBytes(signature.signatureHex),
    signer,
  });

  return {
    hashHex: bytesToHex(hash),
    signatureHex: signature.signatureHex,
    signerHex: signature.publicKeyHex,
    encodedMessageHex: bytesToHex(encodedMessage),
  };
}

export async function submitRawMessage(submitUrl: string, encodedMessageHex: string) {
  return submitSignedMessage(submitUrl, encodedMessageHex);
}

export function bytesToHex(bytes: Uint8Array) {
  return `0x${Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function hexToBytes(hex: string) {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(normalized.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

export function toFarcasterTime(timeMs: number) {
  if (timeMs < FARCASTER_EPOCH_MS) {
    throw new Error("time must be after Farcaster epoch (01/01/2021)");
  }

  const secondsSinceEpoch = Math.round((timeMs - FARCASTER_EPOCH_MS) / 1000);

  if (secondsSinceEpoch > MAX_UINT32) {
    throw new Error("time too far in future");
  }

  return secondsSinceEpoch;
}

export function encodeCastAddMessageData({
  fid,
  text,
  timestamp,
  parentUrl,
}: {
  fid: number;
  text: string;
  timestamp: number;
  parentUrl?: string;
}) {
  const castAddBody = new ProtobufWriter();
  castAddBody.writePackedUint64(2, []);
  if (parentUrl) castAddBody.writeString(7, parentUrl);
  if (text !== "") castAddBody.writeString(4, text);
  castAddBody.writePackedUint32(5, []);

  const messageData = new ProtobufWriter();
  messageData.writeInt32(1, MESSAGE_TYPE_CAST_ADD);
  messageData.writeUint64(2, fid);
  messageData.writeUint32(3, timestamp);
  messageData.writeInt32(4, FARCASTER_NETWORK_MAINNET);
  messageData.writeBytes(5, castAddBody.finish());

  return messageData.finish();
}

export function encodeSignedCastAddMessage({
  dataBytes,
  hash,
  signature,
  signer,
}: {
  dataBytes: Uint8Array;
  hash: Uint8Array;
  signature: Uint8Array;
  signer: Uint8Array;
}) {
  const message = new ProtobufWriter();
  message.writeBytes(1, dataBytes);
  message.writeBytes(2, hash);
  message.writeInt32(3, HASH_SCHEME_BLAKE3);
  message.writeBytes(4, signature);
  message.writeInt32(5, SIGNATURE_SCHEME_ED25519);
  message.writeBytes(6, signer);
  message.writeBytes(7, dataBytes);

  return message.finish();
}

class ProtobufWriter {
  private readonly chunks: number[] = [];
  private readonly encoder = new TextEncoder();

  writeInt32(field: number, value: number) {
    if (value !== 0) this.writeVarintField(field, value);
  }

  writeUint32(field: number, value: number) {
    if (value !== 0) this.writeVarintField(field, value);
  }

  writeUint64(field: number, value: number | bigint) {
    if (BigInt(value) !== 0n) this.writeVarintField(field, value);
  }

  writeString(field: number, value: string) {
    this.writeBytes(field, this.encoder.encode(value));
  }

  writeBytes(field: number, value: Uint8Array) {
    this.writeTag(field, 2);
    this.writeVarint(value.length);
    this.chunks.push(...value);
  }

  writePackedUint32(field: number, values: number[]) {
    const packed = new ProtobufWriter();
    for (const value of values) packed.writeVarint(value);
    this.writeBytes(field, packed.finish());
  }

  writePackedUint64(field: number, values: Array<number | bigint>) {
    const packed = new ProtobufWriter();
    for (const value of values) packed.writeVarint(value);
    this.writeBytes(field, packed.finish());
  }

  finish() {
    return new Uint8Array(this.chunks);
  }

  private writeVarintField(field: number, value: number | bigint) {
    this.writeTag(field, 0);
    this.writeVarint(value);
  }

  private writeTag(field: number, wireType: 0 | 2) {
    this.writeVarint((field << 3) | wireType);
  }

  private writeVarint(value: number | bigint) {
    let current = BigInt(value);

    if (current < 0n) {
      throw new Error("Protobuf varint cannot encode negative values.");
    }

    while (current > 0x7fn) {
      this.chunks.push(Number((current & 0x7fn) | 0x80n));
      current >>= 7n;
    }

    this.chunks.push(Number(current));
  }
}
