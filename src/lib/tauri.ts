import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS } from "./hypersnap";

export type DesktopSettings = typeof DEFAULT_SETTINGS;

export type DesktopAccount = {
  fid: number;
  publicKeyHex: string;
  hasSigner: boolean;
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

export async function createSigner(fid: number): Promise<DesktopAccount> {
  return invoke<DesktopAccount>("create_signer", { fid });
}

export async function importSigner(
  fid: number,
  privateKeyHex: string,
): Promise<DesktopAccount> {
  return invoke<DesktopAccount>("import_signer", { fid, privateKeyHex });
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
