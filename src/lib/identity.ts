import { keccak_256 } from "@noble/hashes/sha3";

export type DerivedCustodyIdentity = {
  address: string;
  derivationPath: string;
};

const DEFAULT_ETH_DERIVATION_PATH = "m/44'/60'/0'/0/0";

export async function deriveCustodyAddressFromMnemonic(
  mnemonic: string,
  derivationPath = DEFAULT_ETH_DERIVATION_PATH,
): Promise<DerivedCustodyIdentity> {
  const normalizedMnemonic = normalizeMnemonic(mnemonic);
  const [{ HDKey }, { mnemonicToSeedSync, validateMnemonic }, { wordlist }, { secp256k1 }] =
    await Promise.all([
      import("@scure/bip32"),
      import("@scure/bip39"),
      import("@scure/bip39/wordlists/english.js"),
      import("@noble/curves/secp256k1.js"),
    ]);

  if (!validateMnemonic(normalizedMnemonic, wordlist)) {
    throw new Error("Mnemonic is not a valid BIP39 English recovery phrase.");
  }

  const seed = mnemonicToSeedSync(normalizedMnemonic);
  const child = HDKey.fromMasterSeed(seed).derive(derivationPath);
  const privateKey = child.privateKey;

  if (!privateKey) {
    seed.fill(0);
    throw new Error("Unable to derive an Ethereum private key from this mnemonic.");
  }

  const publicKey = secp256k1.getPublicKey(privateKey, false).slice(1);
  const address = toChecksumAddress(bytesToPlainHex(keccak_256(publicKey).slice(-20)));

  seed.fill(0);
  privateKey.fill(0);

  return { address, derivationPath };
}

export function normalizeMnemonic(mnemonic: string) {
  return mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
}

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

  const hash = keccakHex(normalized);
  let checksummed = "0x";

  for (let index = 0; index < normalized.length; index += 1) {
    checksummed += Number.parseInt(hash[index], 16) >= 8
      ? normalized[index].toUpperCase()
      : normalized[index];
  }

  return checksummed;
}

function keccakHex(value: string) {
  return bytesToPlainHex(keccak_256(new TextEncoder().encode(value)));
}

function bytesToPlainHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
