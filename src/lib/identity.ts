import { keccak_256 } from "@noble/hashes/sha3";

export function normalizeEthAddress(address: string) {
  const normalized = address.trim();
  return normalized.startsWith("0x") ? normalized : `0x${normalized}`;
}

export function isLikelyEthAddress(address: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(normalizeEthAddress(address));
}

export function toChecksumAddress(addressHex: string) {
  const normalized = normalizeEthAddress(addressHex).slice(2).toLowerCase();

  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error("Expected a 20-byte Ethereum address.");
  }

  const hash = bytesToPlainHex(keccak_256(new TextEncoder().encode(normalized)));
  let checksummed = "0x";

  for (let index = 0; index < normalized.length; index += 1) {
    checksummed += Number.parseInt(hash[index], 16) >= 8
      ? normalized[index].toUpperCase()
      : normalized[index];
  }

  return checksummed;
}

function bytesToPlainHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
