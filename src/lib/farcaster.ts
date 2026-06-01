import { signMessageHash, submitSignedMessage } from "./tauri";

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
  const [{ CastType, Ed25519Signer, FarcasterNetwork, HubError, Message, makeCastAdd }, { err, ok }] =
    await Promise.all([import("@farcaster/core"), import("neverthrow")]);

  class TauriEd25519Signer extends Ed25519Signer {
    constructor(private readonly fid: number) {
      super();
    }

    async getSignerKey() {
      try {
        const response = await signMessageHash(this.fid, zeroHashHex());
        return ok(hexToBytes(response.publicKeyHex));
      } catch (error) {
        return err(
          new HubError(
            "unknown",
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
      }
    }

    async signMessageHash(hash: Uint8Array) {
      try {
        const response = await signMessageHash(this.fid, bytesToHex(hash));
        return ok(hexToBytes(response.signatureHex));
      } catch (error) {
        return err(
          new HubError(
            "unknown",
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
      }
    }
  }

  const validation = validateCastText(text);

  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  const signer = new TauriEd25519Signer(fid);
  const result = await makeCastAdd(
    {
      text: text.trim(),
      embeds: [],
      embedsDeprecated: [],
      mentions: [],
      mentionsPositions: [],
      parentUrl,
      type: CastType.CAST,
    },
    {
      fid,
      network: FarcasterNetwork.MAINNET,
    },
    signer,
  );

  if (result.isErr()) {
    throw result.error;
  }

  const message = result.value;
  const encodedMessage = Message.encode(message).finish();

  return {
    hashHex: bytesToHex(message.hash),
    signatureHex: bytesToHex(message.signature),
    signerHex: bytesToHex(message.signer),
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

function zeroHashHex() {
  return `0x${"00".repeat(20)}`;
}
