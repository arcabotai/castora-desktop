import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS } from "./hypersnap";

export type DesktopSettings = typeof DEFAULT_SETTINGS;

export type DesktopAccount = {
  fid: number;
  publicKeyHex: string;
  hasSigner: boolean;
};

export type CustodyIdentity = {
  address: string;
  derivationPath: string;
  hasKey: boolean;
};

export type SignMessageHashResponse = {
  publicKeyHex: string;
  signatureHex: string;
};

export type RawSubmitResponse = {
  ok: boolean;
  status: number;
  body: string;
};

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getSettings(): Promise<DesktopSettings> {
  if (!isTauriRuntime()) return DEFAULT_SETTINGS;
  return invoke<DesktopSettings>("get_settings");
}

export async function saveSettings(settings: DesktopSettings): Promise<DesktopSettings> {
  if (!isTauriRuntime()) return settings;
  return invoke<DesktopSettings>("save_settings", { settings });
}

export async function getAccount(): Promise<DesktopAccount | null> {
  if (!isTauriRuntime()) return null;
  return invoke<DesktopAccount | null>("get_account");
}

export async function getCustodyIdentity(): Promise<CustodyIdentity | null> {
  if (!isTauriRuntime()) return null;
  return invoke<CustodyIdentity | null>("get_custody_identity");
}

export async function createSigner(fid: number): Promise<DesktopAccount> {
  return invoke<DesktopAccount>("create_signer", { fid });
}

export async function importSigner(
  fid: number,
  privateKeyHex: string,
): Promise<DesktopAccount> {
  return invoke<DesktopAccount>("import_signer", { fid, privateKeyHex });
}

export async function importCustodyFromMnemonic(
  mnemonic: string,
  remember: boolean,
  derivationPath?: string,
): Promise<CustodyIdentity> {
  return invoke<CustodyIdentity>("import_custody_from_mnemonic", {
    mnemonic,
    remember,
    derivationPath,
  });
}

export async function importCustodyPrivateKey(
  privateKeyHex: string,
  remember: boolean,
): Promise<CustodyIdentity> {
  return invoke<CustodyIdentity>("import_custody_private_key", {
    privateKeyHex,
    remember,
  });
}

export async function signMessageHash(
  fid: number,
  hashHex: string,
): Promise<SignMessageHashResponse> {
  return invoke<SignMessageHashResponse>("sign_message_hash", { fid, hashHex });
}

export async function submitSignedMessage(
  submitUrl: string,
  encodedMessageHex: string,
): Promise<RawSubmitResponse> {
  return invoke<RawSubmitResponse>("submit_raw_message", { submitUrl, encodedMessageHex });
}

export async function deleteSigner(fid: number): Promise<void> {
  return invoke<void>("delete_signer", { fid });
}

export async function deleteCustodyIdentity(): Promise<void> {
  return invoke<void>("delete_custody_identity");
}
