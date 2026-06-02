import { useEffect, useMemo, useState, useTransition } from "react";
import {
  AlertCircle,
  ArrowRight,
  Bell,
  Bookmark,
  BookmarkCheck,
  CheckCircle2,
  CircleDot,
  Command,
  Compass,
  Copy,
  Feather,
  Hash,
  Heart,
  Home,
  KeyRound,
  ListChecks,
  Loader2,
  MessageCircle,
  RadioTower,
  RefreshCw,
  Repeat2,
  Save,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserRound,
  Wallet,
  X,
} from "lucide-react";
import "./App.css";
import {
  DEFAULT_SETTINGS,
  fetchSignerEvents,
  fetchSignerKeys,
  fetchTrendingFeed,
  fetchUserByCustodyAddress,
  fetchUserByFid,
  fetchUserByUsername,
  isSignerKeyRegistered,
  isSignerRegistered,
  type HypersnapCast,
  type HypersnapUser,
} from "./lib/hypersnap";
import {
  approveSigner,
  createSigner,
  deleteSigner,
  getAccount,
  getCustodyIdentity,
  getSettings,
  importCustodyFromMnemonic,
  importCustodyPrivateKey,
  saveSettings,
  type CustodyIdentity,
  type DesktopAccount,
  type DesktopSettings,
} from "./lib/tauri";
import { buildSignedCastAdd, submitRawMessage, validateCastText } from "./lib/farcaster";
import { isLikelyEthAddress, normalizeEthAddress } from "./lib/identity";
import { cn } from "./lib/utils";

const navItems = [
  { label: "Home", icon: Home },
  { label: "Explore", icon: Compass },
  { label: "Notifications", icon: Bell },
  { label: "Channels", icon: Hash },
  { label: "Bookmarks", icon: Bookmark },
  { label: "Profile", icon: UserRound },
  { label: "Settings", icon: Settings },
];

const DRAFTS_STORAGE_KEY = "castora-desktop:drafts";
const BOOKMARKS_STORAGE_KEY = "castora-desktop:bookmarks";

type SignerStatusState = "idle" | "checking" | "registered" | "unregistered" | "error";

type SignerStatus = {
  state: SignerStatusState;
  eventCount: number;
  message: string;
  checkedAt?: string;
};

type SavedDraft = {
  id: string;
  text: string;
  createdAt: string;
  fid: number | null;
};

type CommandItem = {
  id: string;
  label: string;
  group: string;
  disabled?: boolean;
  icon: typeof Home;
  action: () => void | Promise<void>;
};

type ConnectMode = "phrase" | "key" | "lookup";

const emptySignerStatus: SignerStatus = {
  state: "idle",
  eventCount: 0,
  message: "Create or import a local desktop signer.",
};

const fallbackCasts: HypersnapCast[] = [
  {
    hash: "local-1",
    text: "Welcome to Castora Desktop. Live Hypersnap reads load from your configured node; the write spike signs a real Farcaster cast message while keeping the signer key in the OS keychain.",
    timestamp: new Date().toISOString(),
    author: {
      fid: 1,
      username: "castora",
      display_name: "Castora",
      pfp_url: "",
      profile: { bio: { text: "Desktop social client for Hypersnap." } },
      follower_count: 0,
      following_count: 0,
    },
    reactions: { likes_count: 12, recasts_count: 3 },
    replies: { count: 2 },
    embeds: [],
  },
];

function App() {
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT_SETTINGS);
  const [account, setAccount] = useState<DesktopAccount | null>(null);
  const [casts, setCasts] = useState<HypersnapCast[]>(fallbackCasts);
  const [feedStatus, setFeedStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [composeText, setComposeText] = useState(
    "Hello from Castora Desktop on Hypersnap.",
  );
  const [fidInput, setFidInput] = useState("");
  const [identitySearchInput, setIdentitySearchInput] = useState("");
  const [custodyAddressInput, setCustodyAddressInput] = useState("");
  const [mnemonicInput, setMnemonicInput] = useState("");
  const [custodyPrivateKeyInput, setCustodyPrivateKeyInput] = useState("");
  const [writeResult, setWriteResult] = useState("");
  const [settingsDraft, setSettingsDraft] = useState<DesktopSettings>(DEFAULT_SETTINGS);
  const [signerStatus, setSignerStatus] = useState<SignerStatus>(emptySignerStatus);
  const [identityPreview, setIdentityPreview] = useState<HypersnapUser | null>(null);
  const [custodyIdentity, setCustodyIdentity] = useState<CustodyIdentity | null>(null);
  const [savedDrafts, setSavedDrafts] = useState<SavedDraft[]>([]);
  const [bookmarkedCastHashes, setBookmarkedCastHashes] = useState<string[]>([]);
  const [selectedCastHash, setSelectedCastHash] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [rememberCustodyKey, setRememberCustodyKey] = useState(true);
  const [autoCreateSignerFromOwner, setAutoCreateSignerFromOwner] = useState(true);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [isPending, startTransition] = useTransition();

  const castValidation = useMemo(() => validateCastText(composeText), [composeText]);
  const activeFid = account?.fid ?? settings.selectedFid ?? null;
  const selectedCast = useMemo(
    () => casts.find((cast) => cast.hash === selectedCastHash) ?? casts[0] ?? null,
    [casts, selectedCastHash],
  );
  const commandItems = useMemo<CommandItem[]>(
    () => [
      {
        id: "new-cast",
        label: "New cast",
        group: "Compose",
        icon: Feather,
        action: () => {
          setCommandOpen(false);
          focusField("compose-text");
        },
      },
      {
        id: "save-draft",
        label: "Save draft",
        group: "Compose",
        icon: Save,
        disabled: composeText.trim().length === 0,
        action: () => {
          handleSaveDraft();
          setCommandOpen(false);
        },
      },
      {
        id: "resolve-identity",
        label: "Resolve identity",
        group: "Account",
        icon: UserCheck,
        action: () => {
          setCommandOpen(false);
          focusField("identity-search");
        },
      },
      {
        id: "owner-key",
        label: "Import owner key",
        group: "Account",
        icon: ShieldCheck,
        action: () => {
          setCommandOpen(false);
          focusField("mnemonic");
        },
      },
      {
        id: "approve-signer",
        label: "Approve local signer",
        group: "Account",
        icon: ShieldCheck,
        disabled: !account || signerStatus.state === "checking" || signerStatus.state === "registered",
        action: async () => {
          await handleApproveSigner(account);
          setCommandOpen(false);
        },
      },
      {
        id: "check-signer",
        label: "Check signer approval",
        group: "Account",
        icon: RefreshCw,
        disabled: !account || signerStatus.state === "checking",
        action: async () => {
          await checkSignerReadiness(account);
          setCommandOpen(false);
        },
      },
      {
        id: "reply",
        label: "Reply to selected cast",
        group: "Feed",
        icon: MessageCircle,
        disabled: !selectedCast,
        action: () => {
          if (selectedCast) handleStartReply(selectedCast);
          setCommandOpen(false);
        },
      },
      {
        id: "bookmark",
        label: selectedCast && bookmarkedCastHashes.includes(selectedCast.hash)
          ? "Remove selected bookmark"
          : "Bookmark selected cast",
        group: "Feed",
        icon: Bookmark,
        disabled: !selectedCast,
        action: () => {
          if (selectedCast) handleToggleBookmark(selectedCast);
          setCommandOpen(false);
        },
      },
      {
        id: "previous-cast",
        label: "Previous cast",
        group: "Feed",
        icon: ArrowRight,
        disabled: casts.length === 0,
        action: () => {
          moveSelectedCast(-1);
          setCommandOpen(false);
        },
      },
      {
        id: "next-cast",
        label: "Next cast",
        group: "Feed",
        icon: ArrowRight,
        disabled: casts.length === 0,
        action: () => {
          moveSelectedCast(1);
          setCommandOpen(false);
        },
      },
    ],
    [
      account,
      activeFid,
      bookmarkedCastHashes,
      casts.length,
      composeText,
      savedDrafts,
      selectedCast,
      settings.nodeBaseUrl,
      signerStatus.state,
    ],
  );

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const [storedSettings, storedAccount, storedCustody] = await Promise.all([
        getSettings(),
        getAccount(),
        getCustodyIdentity(),
      ]);

      if (cancelled) return;

      setSettings(storedSettings);
      setSettingsDraft(storedSettings);
      setAccount(storedAccount);
      setCustodyIdentity(storedCustody);
      setCustodyAddressInput(storedCustody?.address ?? "");
      setFidInput(storedAccount?.fid ? String(storedAccount.fid) : "");
      setBootstrapped(true);
    }

    bootstrap().catch((error) => {
      setWriteResult(`Startup warning: ${String(error)}`);
      setBootstrapped(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      const rawDrafts = window.localStorage.getItem(DRAFTS_STORAGE_KEY);
      const parsedDrafts = rawDrafts ? JSON.parse(rawDrafts) : [];

      if (Array.isArray(parsedDrafts)) {
        setSavedDrafts(parsedDrafts.filter(isSavedDraft).slice(0, 12));
      }
    } catch {
      setSavedDrafts([]);
    }
  }, []);

  useEffect(() => {
    try {
      const rawBookmarks = window.localStorage.getItem(BOOKMARKS_STORAGE_KEY);
      const parsedBookmarks = rawBookmarks ? JSON.parse(rawBookmarks) : [];

      if (Array.isArray(parsedBookmarks)) {
        setBookmarkedCastHashes(
          parsedBookmarks.filter((value): value is string => typeof value === "string"),
        );
      }
    } catch {
      setBookmarkedCastHashes([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadFeed() {
      setFeedStatus("loading");
      try {
        const nextCasts = await fetchTrendingFeed(settings.nodeBaseUrl);
        if (!cancelled) {
          setCasts(nextCasts.length > 0 ? nextCasts : fallbackCasts);
          setFeedStatus("ready");
        }
      } catch {
        if (!cancelled) {
          setCasts(fallbackCasts);
          setFeedStatus("error");
        }
      }
    }

    loadFeed();

    return () => {
      cancelled = true;
    };
  }, [settings.nodeBaseUrl]);

  useEffect(() => {
    if (!account) {
      setSignerStatus(emptySignerStatus);
      return;
    }

    void checkSignerReadiness(account);
  }, [account?.fid, account?.publicKeyHex, settings.nodeBaseUrl]);

  useEffect(() => {
    if (!activeFid) {
      setIdentityPreview(null);
      return;
    }

    let cancelled = false;

    fetchUserByFid(settings.nodeBaseUrl, activeFid)
      .then((user) => {
        if (!cancelled) setIdentityPreview(user);
      })
      .catch(() => {
        if (!cancelled) setIdentityPreview(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeFid, settings.nodeBaseUrl]);

  useEffect(() => {
    if (casts.length === 0) {
      setSelectedCastHash(null);
      return;
    }

    if (!selectedCastHash || !casts.some((cast) => cast.hash === selectedCastHash)) {
      setSelectedCastHash(casts[0].hash);
    }
  }, [casts, selectedCastHash]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((current) => !current);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        focusField("compose-text");
        return;
      }

      if (event.key === "Escape" && commandOpen) {
        event.preventDefault();
        setCommandOpen(false);
        return;
      }

      if (commandOpen || isTextEntryActive()) return;

      if (event.key.toLowerCase() === "j") {
        event.preventDefault();
        moveSelectedCast(1);
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        moveSelectedCast(-1);
      } else if (event.key.toLowerCase() === "r" && selectedCast) {
        event.preventDefault();
        handleStartReply(selectedCast);
      } else if (event.key.toLowerCase() === "b" && selectedCast) {
        event.preventDefault();
        handleToggleBookmark(selectedCast);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [commandOpen, selectedCast, casts, selectedCastHash, bookmarkedCastHashes]);

  async function persistSettings() {
    const saved = await saveSettings(settingsDraft);
    setSettings(saved);
    setSettingsDraft(saved);
  }

  function persistDrafts(nextDrafts: SavedDraft[]) {
    const cappedDrafts = nextDrafts.slice(0, 12);
    setSavedDrafts(cappedDrafts);
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(cappedDrafts));
  }

  function persistBookmarks(nextHashes: string[]) {
    const uniqueHashes = Array.from(new Set(nextHashes)).slice(0, 100);
    setBookmarkedCastHashes(uniqueHashes);
    window.localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(uniqueHashes));
  }

  function handleToggleBookmark(cast: HypersnapCast) {
    const isBookmarked = bookmarkedCastHashes.includes(cast.hash);
    const nextHashes = isBookmarked
      ? bookmarkedCastHashes.filter((hash) => hash !== cast.hash)
      : [cast.hash, ...bookmarkedCastHashes];

    persistBookmarks(nextHashes);
    setSelectedCastHash(cast.hash);
    setWriteResult(isBookmarked ? "Removed bookmark." : "Bookmarked cast locally.");
  }

  function handleStartReply(cast: HypersnapCast) {
    const handle = cast.author.username ? `@${cast.author.username}` : `fid:${cast.author.fid}`;
    setSelectedCastHash(cast.hash);
    setComposeText(`${handle} `);
    setWriteResult("Reply draft started locally.");
  }

  function moveSelectedCast(offset: number) {
    if (casts.length === 0) return;

    const currentIndex = Math.max(
      0,
      casts.findIndex((cast) => cast.hash === selectedCastHash),
    );
    const nextIndex = Math.min(Math.max(currentIndex + offset, 0), casts.length - 1);
    const nextCast = casts[nextIndex];

    setSelectedCastHash(nextCast.hash);
    window.setTimeout(() => {
      document.getElementById(castRowId(nextCast.hash))?.scrollIntoView({
        block: "nearest",
      });
    }, 0);
  }

  async function checkSignerReadiness(
    targetAccount = account,
    nodeBaseUrl = settings.nodeBaseUrl,
  ) {
    if (!targetAccount) {
      setSignerStatus(emptySignerStatus);
      return false;
    }

    setSignerStatus({
      state: "checking",
      eventCount: 0,
      message: "Checking signer approval on Hypersnap.",
    });

    try {
      let signerCount = 0;
      let registered = false;

      try {
        const signerKeys = await fetchSignerKeys(nodeBaseUrl, targetAccount.fid);
        signerCount = signerKeys.length;
        registered = isSignerKeyRegistered(signerKeys, targetAccount.publicKeyHex);
      } catch {
        const events = await fetchSignerEvents(nodeBaseUrl, targetAccount.fid);
        signerCount = events.length;
        registered = isSignerRegistered(events, targetAccount.publicKeyHex);
      }

      setSignerStatus({
        state: registered ? "registered" : "unregistered",
        eventCount: signerCount,
        checkedAt: new Date().toISOString(),
        message: registered
          ? "This desktop signer is approved for writes."
          : "Your account is connected. Castora can approve this local signer from your saved owner key.",
      });

      return registered;
    } catch (error) {
      setSignerStatus({
        state: "error",
        eventCount: 0,
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async function activateLocalSignerForFid(fid: number, source: string) {
    if (!fid) {
      throw new Error("Resolve an existing FID before creating a signer.");
    }

    if (account?.fid === fid) {
      return account;
    }

    const nextAccount = await createSigner(fid);
    const savedSettings = await saveSettings({ ...settings, selectedFid: fid });
    setAccount(nextAccount);
    setSettings(savedSettings);
    setSettingsDraft((current) => ({ ...current, selectedFid: fid }));
    setSignerStatus({
      state: "unregistered",
      eventCount: 0,
      message: "Local signer created. Approval is the final protocol step before publishing.",
    });
    setWriteResult(
      `Created local desktop signer ${nextAccount.publicKeyHex.slice(0, 18)}... for FID ${fid} from ${source}. Approve this public key through Farcaster's signer approval flow, then check approval.`,
    );

    return nextAccount;
  }

  async function handleApproveSigner(targetAccount = account, source = "manual approval") {
    if (!targetAccount) {
      throw new Error("Create a local desktop signer before approving it.");
    }

    setSignerStatus({
      state: "checking",
      eventCount: 0,
      message: "Approving local signer with your saved owner key.",
    });
    setWriteResult("Submitting signer approval to Hypersnap.");

    try {
      setWriteResult(
        "macOS may ask for login keychain access. Enter your Mac password and choose Always Allow to let Castora approve this signer.",
      );
      const approval = await withTimeout(
        approveSigner(targetAccount.fid, settings.hubSubmitUrl),
        18_000,
        "Signer approval is still waiting on the native keychain or hub. Try again, and approve any macOS keychain prompt if one appears.",
      );
      setWriteResult(
        `Submitted signer approval ${approval.hashHex.slice(0, 18)}... for FID ${targetAccount.fid} from ${source}. Checking registration now.`,
      );

      const registered = await checkSignerReadiness(targetAccount);

      if (!registered) {
        setWriteResult(
          `Submitted signer approval ${approval.hashHex.slice(0, 18)}... . Hypersnap may need a moment to index it; check approval again shortly.`,
        );
      }

      return registered;
    } catch (error) {
      setSignerStatus({
        state: "unregistered",
        eventCount: 0,
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async function handleCreateSigner() {
    const nextAccount = await activateLocalSignerForFid(Number(fidInput), "manual setup");
    if (custodyIdentity?.hasKey) {
      await handleApproveSigner(nextAccount, "manual setup");
    }
  }

  async function handleDeleteSigner() {
    if (!activeFid) return;
    await deleteSigner(activeFid);
    setAccount(null);
    setSignerStatus(emptySignerStatus);
    setWriteResult(`Deleted local signer for FID ${activeFid}.`);
  }

  function handleSaveDraft() {
    if (composeText.trim().length === 0) {
      setWriteResult("Write something before saving a draft.");
      return;
    }

    const nextDraft: SavedDraft = {
      id: crypto.randomUUID(),
      text: composeText,
      createdAt: new Date().toISOString(),
      fid: activeFid,
    };

    const dedupedDrafts = savedDrafts.filter(
      (draft) => draft.text.trim() !== composeText.trim(),
    );
    persistDrafts([nextDraft, ...dedupedDrafts]);
    setWriteResult("Saved draft locally.");
  }

  function handleLoadDraft(draft: SavedDraft) {
    setComposeText(draft.text);
    setWriteResult("Loaded draft.");
  }

  function handleDeleteDraft(id: string) {
    persistDrafts(savedDrafts.filter((draft) => draft.id !== id));
    setWriteResult("Deleted draft.");
  }

  function handleClearCompose() {
    setComposeText("");
    setWriteResult("Cleared compose box.");
  }

  function focusField(id: string) {
    document.getElementById(id)?.focus();
  }

  function applyResolvedUser(user: HypersnapUser, source: string) {
    setIdentityPreview(user);
    setFidInput(String(user.fid));
    setIdentitySearchInput(user.username || String(user.fid));
    setWriteResult(
      `Resolved ${getUserDisplayName(user)} (${getUserUsername(user)}) from ${source}.`,
    );
  }

  async function handleResolveIdentity() {
    const query = identitySearchInput.trim();

    if (!query) {
      focusField("identity-search");
      return;
    }

    const user = /^\d+$/.test(query)
      ? await fetchUserByFid(settings.nodeBaseUrl, Number(query))
      : await fetchUserByUsername(settings.nodeBaseUrl, query);

    applyResolvedUser(user, /^\d+$/.test(query) ? "FID" : "username");
  }

  async function handleResolveCustodyAddress(address = custodyAddressInput) {
    const normalizedAddress = normalizeEthAddress(address);

    if (!isLikelyEthAddress(normalizedAddress)) {
      throw new Error("Enter a 0x-prefixed Ethereum custody address.");
    }

    const user = await fetchUserByCustodyAddress(settings.nodeBaseUrl, normalizedAddress);
    setCustodyAddressInput(normalizedAddress);
    applyResolvedUser(user, "custody address");

    return user;
  }

  async function handleResolveMnemonic() {
    const mnemonic = mnemonicInput;
    setMnemonicInput("");

    try {
      const custody = await importCustodyFromMnemonic(
        mnemonic,
        rememberCustodyKey,
      );
      setCustodyIdentity(custody);
      setCustodyAddressInput(custody.address);
      const user = await handleResolveCustodyAddress(custody.address);

      if (autoCreateSignerFromOwner) {
        const nextAccount = await activateLocalSignerForFid(user.fid, "owner key");
        if (custody.hasKey) {
          await handleApproveSigner(nextAccount, "owner key");
          return;
        }
      } else {
        setWriteResult(
          `Resolved ${getUserUsername(user)} from local owner key. Custody ${custody.hasKey ? "saved" : "not saved"} in keychain.`,
        );
      }
    } finally {
      setMnemonicInput("");
    }
  }

  async function handleImportCustodyPrivateKey() {
    const privateKeyHex = custodyPrivateKeyInput;
    setCustodyPrivateKeyInput("");

    try {
      const custody = await importCustodyPrivateKey(privateKeyHex, rememberCustodyKey);
      setCustodyIdentity(custody);
      setCustodyAddressInput(custody.address);
      const user = await handleResolveCustodyAddress(custody.address);

      if (autoCreateSignerFromOwner) {
        const nextAccount = await activateLocalSignerForFid(user.fid, "custody key");
        if (custody.hasKey) {
          await handleApproveSigner(nextAccount, "custody key");
          return;
        }
      } else {
        setWriteResult(
          `Resolved ${getUserUsername(user)} from custody key. Custody ${custody.hasKey ? "saved" : "not saved"} in keychain.`,
        );
      }
    } finally {
      setCustodyPrivateKeyInput("");
    }
  }

  async function handleDryRun() {
    if (!activeFid) {
      setWriteResult("Add or import a signer before building a message.");
      return;
    }

    if (!castValidation.valid) {
      setWriteResult(castValidation.reason);
      return;
    }

    const signed = await buildSignedCastAdd({
      fid: activeFid,
      text: composeText,
    });

    setWriteResult(
      `Signed cast message ${signed.hashHex.slice(0, 18)}... (${signed.encodedMessageHex.length / 2} bytes).`,
    );
  }

  async function handleSubmit() {
    if (!activeFid) {
      setWriteResult("Add or import a signer before submitting a message.");
      return;
    }

    if (signerStatus.state !== "registered") {
      setWriteResult(
        "Publishing is blocked until this local signer is approved for your FID. Use Approve now in the account panel, then Castora will check approval again.",
      );
      return;
    }

    if (!castValidation.valid) {
      setWriteResult(castValidation.reason);
      return;
    }

    const signed = await buildSignedCastAdd({
      fid: activeFid,
      text: composeText,
    });
    const result = await submitRawMessage(settings.hubSubmitUrl, signed.encodedMessageHex);
    setWriteResult(
      `Submitted ${signed.hashHex.slice(0, 18)}... with HTTP ${result.status}: ${result.body.slice(0, 180)}`,
    );
  }

  if (!bootstrapped) {
    return <AppLoadingScreen />;
  }

  if (!account) {
    return (
      <ConnectAccountScreen
        autoCreateSignerFromOwner={autoCreateSignerFromOwner}
        casts={casts}
        custodyAddressInput={custodyAddressInput}
        custodyIdentity={custodyIdentity}
        custodyPrivateKeyInput={custodyPrivateKeyInput}
        feedStatus={feedStatus}
        fidInput={fidInput}
        identityPreview={identityPreview}
        identitySearchInput={identitySearchInput}
        mnemonicInput={mnemonicInput}
        rememberCustodyKey={rememberCustodyKey}
        writeResult={writeResult}
        onAutoCreateSignerFromOwnerChange={setAutoCreateSignerFromOwner}
        onCreateSigner={handleCreateSigner}
        onCustodyAddressChange={setCustodyAddressInput}
        onCustodyPrivateKeyChange={setCustodyPrivateKeyInput}
        onIdentitySearchChange={setIdentitySearchInput}
        onImportCustodyPrivateKey={handleImportCustodyPrivateKey}
        onMnemonicChange={setMnemonicInput}
        onReport={setWriteResult}
        onRememberCustodyKeyChange={setRememberCustodyKey}
        onResolveCustodyAddress={handleResolveCustodyAddress}
        onResolveIdentity={handleResolveIdentity}
        onResolveMnemonic={handleResolveMnemonic}
        onSetFidInput={setFidInput}
      />
    );
  }

  return (
    <main className="min-h-screen bg-mist text-slate-950">
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[232px_minmax(0,1fr)_356px]">
        <aside className="hidden border-r border-slate-200 bg-white/88 px-4 py-5 lg:block">
          <div className="mb-7 flex items-center gap-3 px-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-ink text-snap">
              <RadioTower className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-base font-bold leading-5">Castora</p>
              <p className="text-xs font-medium text-slate-500">Hypersnap desktop</p>
            </div>
          </div>

          <nav className="space-y-1" aria-label="Primary">
            {navItems.map((item, index) => {
              const Icon = item.icon;
              const active = index === 0;
              return (
                <button
                  key={item.label}
                  className={cn(
                    "flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-semibold transition",
                    active
                      ? "bg-ink text-white"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-950",
                  )}
                  type="button"
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="mt-8 rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="h-4 w-4 text-moss" aria-hidden="true" />
              Local custody
            </div>
            <p className="text-xs leading-5 text-slate-500">
              Owner and signer keys stay in the OS keychain. Approval delegates posting
              only; it does not transfer account ownership.
            </p>
          </div>
        </aside>

        <section className="min-w-0 border-r border-slate-200 bg-white">
          <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-slate-200 bg-white/95 px-6 backdrop-blur">
            <div>
              <h1 className="text-lg font-bold">Home</h1>
              <p className="text-xs font-medium text-slate-500">
                {feedStatus === "loading"
                  ? "Loading Hypersnap..."
                  : feedStatus === "error"
                    ? "Showing local fallback"
                    : "Live Hypersnap feed"}
              </p>
            </div>
            <div className="hidden items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-500 sm:flex">
              <Search className="h-4 w-4" aria-hidden="true" />
              Search casts, people, channels
            </div>
          </header>

          <div className="scrollbar-subtle h-[calc(100vh-4rem)] overflow-y-auto">
            <Composer
              activeFid={activeFid}
              composeText={composeText}
              isPending={isPending}
              setComposeText={setComposeText}
              signerStatus={signerStatus}
              startTransition={startTransition}
              validation={castValidation}
              onClear={handleClearCompose}
              onDryRun={handleDryRun}
              onSaveDraft={handleSaveDraft}
              onSubmit={handleSubmit}
            />

            <ol className="divide-y divide-slate-200">
              {casts.map((cast) => (
                <CastRow
                  key={cast.hash}
                  cast={cast}
                  isBookmarked={bookmarkedCastHashes.includes(cast.hash)}
                  isSelected={selectedCast?.hash === cast.hash}
                  onBookmark={() => handleToggleBookmark(cast)}
                  onReply={() => handleStartReply(cast)}
                  onSelect={() => setSelectedCastHash(cast.hash)}
                />
              ))}
            </ol>
          </div>
        </section>

        <aside className="scrollbar-subtle h-auto overflow-y-auto bg-slate-50 px-5 py-5 lg:h-screen">
          <SessionPanel
            account={account}
            identityPreview={identityPreview}
            signerStatus={signerStatus}
            onApproveSigner={() => handleApproveSigner(account)}
            onCheckSigner={() => checkSignerReadiness(account)}
            onDeleteSigner={handleDeleteSigner}
            onFocusCompose={() => focusField("compose-text")}
            setWriteResult={setWriteResult}
          />

          <CastDetailPanel
            cast={selectedCast}
            isBookmarked={
              selectedCast ? bookmarkedCastHashes.includes(selectedCast.hash) : false
            }
            onBookmark={() => {
              if (selectedCast) handleToggleBookmark(selectedCast);
            }}
            onReply={() => {
              if (selectedCast) handleStartReply(selectedCast);
            }}
          />

          <DraftsPanel
            drafts={savedDrafts}
            onDeleteDraft={handleDeleteDraft}
            onLoadDraft={handleLoadDraft}
          />

          <SettingsPanel
            draft={settingsDraft}
            onChange={setSettingsDraft}
            onSave={persistSettings}
          />

          <div className="mt-4 rounded-md border border-slate-200 bg-white p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-bold">
              <Feather className="h-4 w-4 text-ember" aria-hidden="true" />
              Status
            </div>
            <p className="min-h-20 rounded-md bg-slate-950 p-3 text-xs leading-5 text-slate-100">
              {writeResult || "Ready for local drafts, signing checks, and test submits."}
            </p>
          </div>
        </aside>
      </div>
      <CommandPalette
        commands={commandItems}
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
      />
    </main>
  );
}

function AppLoadingScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-mist text-slate-950">
      <div className="flex items-center gap-3 rounded-md border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-ink text-snap">
          <RadioTower className="h-4 w-4" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-bold">Castora</p>
          <p className="text-xs font-medium text-slate-500">Opening workspace</p>
        </div>
      </div>
    </main>
  );
}

function ConnectAccountScreen({
  autoCreateSignerFromOwner,
  casts,
  custodyAddressInput,
  custodyIdentity,
  custodyPrivateKeyInput,
  feedStatus,
  fidInput,
  identityPreview,
  identitySearchInput,
  mnemonicInput,
  rememberCustodyKey,
  writeResult,
  onAutoCreateSignerFromOwnerChange,
  onCreateSigner,
  onCustodyAddressChange,
  onCustodyPrivateKeyChange,
  onIdentitySearchChange,
  onImportCustodyPrivateKey,
  onMnemonicChange,
  onRememberCustodyKeyChange,
  onReport,
  onResolveCustodyAddress,
  onResolveIdentity,
  onResolveMnemonic,
  onSetFidInput,
}: {
  autoCreateSignerFromOwner: boolean;
  casts: HypersnapCast[];
  custodyAddressInput: string;
  custodyIdentity: CustodyIdentity | null;
  custodyPrivateKeyInput: string;
  feedStatus: "idle" | "loading" | "ready" | "error";
  fidInput: string;
  identityPreview: HypersnapUser | null;
  identitySearchInput: string;
  mnemonicInput: string;
  rememberCustodyKey: boolean;
  writeResult: string;
  onAutoCreateSignerFromOwnerChange: (value: boolean) => void;
  onCreateSigner: () => Promise<void>;
  onCustodyAddressChange: (value: string) => void;
  onCustodyPrivateKeyChange: (value: string) => void;
  onIdentitySearchChange: (value: string) => void;
  onImportCustodyPrivateKey: () => Promise<void>;
  onMnemonicChange: (value: string) => void;
  onRememberCustodyKeyChange: (value: boolean) => void;
  onReport: (message: string) => void;
  onResolveCustodyAddress: () => Promise<HypersnapUser | undefined>;
  onResolveIdentity: () => Promise<void>;
  onResolveMnemonic: () => Promise<void>;
  onSetFidInput: (value: string) => void;
}) {
  const [connectMode, setConnectMode] = useState<ConnectMode>("phrase");
  const [busyAction, setBusyAction] = useState<
    "phrase" | "key" | "identity" | "custody" | "signer" | null
  >(null);
  const visibleCasts = casts.slice(0, 4);
  const fidReady = Boolean(identityPreview?.fid || Number(fidInput));

  async function run(
    action: "phrase" | "key" | "identity" | "custody" | "signer",
    callback: () => Promise<unknown>,
  ) {
    setBusyAction(action);
    try {
      await callback();
    } catch (error) {
      onReport(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <main className="min-h-screen bg-mist text-slate-950">
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[minmax(0,1fr)_430px]">
        <section className="min-w-0 border-r border-slate-200 bg-white">
          <header className="flex h-16 items-center justify-between border-b border-slate-200 px-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-ink text-snap">
                <RadioTower className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <p className="text-base font-bold leading-5">Castora</p>
                <p className="text-xs font-medium text-slate-500">Hypersnap desktop</p>
              </div>
            </div>
            <span
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-bold",
                feedStatus === "ready"
                  ? "bg-moss/15 text-emerald-700"
                  : feedStatus === "error"
                    ? "bg-amber-100 text-amber-800"
                    : "bg-snap/15 text-cyan-700",
              )}
            >
              {feedStatus === "ready"
                ? "Live feed"
                : feedStatus === "error"
                  ? "Fallback feed"
                  : "Connecting"}
            </span>
          </header>

          <div className="scrollbar-subtle h-[calc(100vh-4rem)] overflow-y-auto">
            <section className="border-b border-slate-200 px-6 py-5">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h1 className="text-lg font-bold">Home</h1>
                  <p className="text-xs font-medium text-slate-500">
                    Connect an account to compose from desktop.
                  </p>
                </div>
                <div className="hidden items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-500 sm:flex">
                  <Search className="h-4 w-4" aria-hidden="true" />
                  Search casts, people, channels
                </div>
              </div>

              <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-bold">Compose</p>
                    <p className="text-xs font-medium text-slate-500">No signer selected</p>
                  </div>
                  <span className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">
                    0/320
                  </span>
                </div>
                <div className="min-h-24 rounded-md border border-dashed border-slate-300 bg-white" />
              </div>
            </section>

            <ol className="divide-y divide-slate-200">
              {visibleCasts.map((cast) => (
                <ConnectFeedPreviewRow key={cast.hash} cast={cast} />
              ))}
            </ol>
          </div>
        </section>

        <aside className="scrollbar-subtle h-auto overflow-y-auto bg-slate-50 px-5 py-5 lg:h-screen">
          <section className="rounded-md border border-slate-200 bg-white p-4">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-bold">
                  <ShieldCheck className="h-4 w-4 text-moss" aria-hidden="true" />
                  Connect account
                </div>
                <p className="mt-1 text-xs font-medium leading-5 text-slate-500">
                  Local owner key, local desktop signer.
                </p>
              </div>
              <span className="rounded-md bg-snap/10 px-2 py-1 text-xs font-bold text-cyan-800">
                Private
              </span>
            </div>

            <div className="mb-4 grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1">
              {[
                { id: "phrase", label: "Phrase", icon: ShieldAlert },
                { id: "key", label: "Key", icon: KeyRound },
                { id: "lookup", label: "FID", icon: UserCheck },
              ].map((item) => {
                const Icon = item.icon;
                const active = connectMode === item.id;
                return (
                  <button
                    key={item.id}
                    className={cn(
                      "inline-flex h-9 items-center justify-center gap-2 rounded-md text-xs font-bold transition",
                      active
                        ? "bg-white text-slate-950 shadow-sm"
                        : "text-slate-500 hover:text-slate-800",
                    )}
                    type="button"
                    onClick={() => setConnectMode(item.id as ConnectMode)}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {item.label}
                  </button>
                );
              })}
            </div>

            {connectMode === "phrase" ? (
              <div>
                <label className="block text-xs font-bold text-slate-500" htmlFor="first-run-mnemonic">
                  Recovery phrase
                </label>
                <textarea
                  id="first-run-mnemonic"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="mt-1 min-h-28 w-full resize-none rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-snap focus:bg-white"
                  value={mnemonicInput}
                  onChange={(event) => onMnemonicChange(event.currentTarget.value)}
                  placeholder="BIP39 recovery phrase"
                />
                <button
                  className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-ink px-3 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-50"
                  type="button"
                  disabled={busyAction !== null || mnemonicInput.trim().split(/\s+/).length < 12}
                  onClick={() => run("phrase", onResolveMnemonic)}
                >
                  {busyAction === "phrase" ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  )}
                  Connect with phrase
                </button>
              </div>
            ) : null}

            {connectMode === "key" ? (
              <div>
                <label className="block text-xs font-bold text-slate-500" htmlFor="first-run-custody-key">
                  Custody private key
                </label>
                <input
                  id="first-run-custody-key"
                  autoComplete="off"
                  className="mt-1 h-10 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-snap focus:bg-white"
                  value={custodyPrivateKeyInput}
                  onChange={(event) => onCustodyPrivateKeyChange(event.currentTarget.value)}
                  placeholder="0x..."
                  type="password"
                />
                <button
                  className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-ink px-3 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-50"
                  type="button"
                  disabled={busyAction !== null || custodyPrivateKeyInput.trim().length < 64}
                  onClick={() => run("key", onImportCustodyPrivateKey)}
                >
                  {busyAction === "key" ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  )}
                  Connect with key
                </button>
              </div>
            ) : null}

            {connectMode === "lookup" ? (
              <div>
                <label className="block text-xs font-bold text-slate-500" htmlFor="first-run-identity">
                  FID or username
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id="first-run-identity"
                    className="h-10 min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-snap focus:bg-white"
                    value={identitySearchInput}
                    onChange={(event) => onIdentitySearchChange(event.currentTarget.value)}
                    placeholder="dwr or 3"
                  />
                  <button
                    className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-ink text-white hover:bg-slate-800 disabled:opacity-50"
                    type="button"
                    aria-label="Resolve identity"
                    disabled={busyAction !== null || identitySearchInput.trim().length === 0}
                    onClick={() => run("identity", onResolveIdentity)}
                  >
                    {busyAction === "identity" ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Search className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>

                <label className="mt-3 block text-xs font-bold text-slate-500" htmlFor="first-run-custody-address">
                  Custody address
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id="first-run-custody-address"
                    className="h-10 min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-snap focus:bg-white"
                    value={custodyAddressInput}
                    onChange={(event) => onCustodyAddressChange(event.currentTarget.value)}
                    placeholder="0x..."
                  />
                  <button
                    className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                    type="button"
                    aria-label="Resolve custody address"
                    disabled={busyAction !== null || custodyAddressInput.trim().length === 0}
                    onClick={() => run("custody", onResolveCustodyAddress)}
                  >
                    {busyAction === "custody" ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Wallet className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>

                <label className="mt-3 block text-xs font-bold text-slate-500" htmlFor="first-run-fid">
                  Existing FID
                </label>
                <input
                  id="first-run-fid"
                  className="mt-1 h-10 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-snap focus:bg-white"
                  inputMode="numeric"
                  value={fidInput}
                  onChange={(event) => onSetFidInput(event.currentTarget.value)}
                  placeholder="12345"
                />
                <button
                  className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-ink px-3 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-50"
                  type="button"
                  disabled={busyAction !== null || !fidReady}
                  onClick={() => run("signer", onCreateSigner)}
                >
                  {busyAction === "signer" ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  )}
                  Create desktop signer
                </button>
              </div>
            ) : null}

            {connectMode !== "lookup" ? (
              <div className="mt-4 grid gap-2 text-xs font-semibold text-slate-600">
                <label className="flex items-center gap-2">
                  <input
                    className="h-4 w-4 rounded border-slate-300 text-snap focus:ring-snap"
                    type="checkbox"
                    checked={rememberCustodyKey}
                    onChange={(event) => onRememberCustodyKeyChange(event.currentTarget.checked)}
                  />
                  Save custody key in Keychain
                </label>
                <label className="flex items-center gap-2">
                  <input
                    className="h-4 w-4 rounded border-slate-300 text-snap focus:ring-snap"
                    type="checkbox"
                    checked={autoCreateSignerFromOwner}
                    onChange={(event) =>
                      onAutoCreateSignerFromOwnerChange(event.currentTarget.checked)
                    }
                  />
                  Create desktop signer
                </label>
              </div>
            ) : null}

            {identityPreview ? (
              <ConnectIdentityPreview user={identityPreview} />
            ) : custodyIdentity ? (
              <div className="mt-4 rounded-md bg-slate-50 p-3">
                <p className="text-xs font-bold text-slate-500">Custody address</p>
                <p className="mt-1 break-all font-mono text-[11px] leading-4 text-slate-700">
                  {custodyIdentity.address}
                </p>
              </div>
            ) : null}

            {writeResult ? (
              <p className="mt-4 rounded-md bg-slate-950 p-3 text-xs font-semibold leading-5 text-slate-100">
                {writeResult}
              </p>
            ) : null}
          </section>

          <section className="mt-4 rounded-md border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2 text-sm font-bold">
              <ListChecks className="h-4 w-4 text-snap" aria-hidden="true" />
              Session
            </div>
            <ol className="mt-3 space-y-2">
              <ConnectStep done={Boolean(custodyIdentity)} label="Owner key" />
              <ConnectStep done={Boolean(identityPreview)} label="Account match" />
              <ConnectStep done={false} label="Desktop signer" />
              <ConnectStep done={false} label="Signer approval" />
              <ConnectStep done={false} label="Ready to cast" />
            </ol>
          </section>
        </aside>
      </div>
    </main>
  );
}

function ConnectFeedPreviewRow({ cast }: { cast: HypersnapCast }) {
  return (
    <li className="px-6 py-4">
      <div className="flex gap-3">
        {cast.author.pfp_url ? (
          <img
            className="h-10 w-10 flex-none rounded-md object-cover"
            src={cast.author.pfp_url}
            alt=""
          />
        ) : (
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-md bg-ink text-sm font-bold text-snap">
            {getCastDisplayName(cast).slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate text-sm font-bold">{getCastDisplayName(cast)}</p>
            <span className="text-sm font-medium text-slate-500">
              {getCastUsername(cast)}
            </span>
          </div>
          <p className="mt-1 max-h-24 overflow-hidden text-sm leading-6 text-slate-800">
            {cast.text || " "}
          </p>
          <div className="mt-3 flex gap-5 text-xs font-medium text-slate-500">
            <span>{cast.replies.count} replies</span>
            <span>{cast.reactions.likes_count} likes</span>
            <span>{cast.reactions.recasts_count} recasts</span>
          </div>
        </div>
      </div>
    </li>
  );
}

function ConnectIdentityPreview({ user }: { user: HypersnapUser }) {
  const displayName = getUserDisplayName(user);

  return (
    <div className="mt-4 rounded-md bg-slate-50 p-3">
      <div className="flex items-center gap-3">
        {user.pfp_url ? (
          <img className="h-10 w-10 rounded-md object-cover" src={user.pfp_url} alt="" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-ink text-sm font-bold text-snap">
            {displayName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{displayName}</p>
          <p className="truncate text-xs font-medium text-slate-500">
            {getUserUsername(user)} · FID {user.fid}
          </p>
        </div>
      </div>
      {user.custody_address ? (
        <p className="mt-2 break-all font-mono text-[11px] leading-4 text-slate-500">
          {user.custody_address}
        </p>
      ) : null}
    </div>
  );
}

function ConnectStep({ done, label }: { done: boolean; label: string }) {
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-bold",
        done
          ? "border-emerald-100 bg-moss/10 text-emerald-700"
          : "border-slate-100 bg-slate-50 text-slate-500",
      )}
    >
      {done ? (
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
      ) : (
        <CircleDot className="h-4 w-4" aria-hidden="true" />
      )}
      {label}
    </li>
  );
}

function Composer({
  activeFid,
  composeText,
  isPending,
  setComposeText,
  signerStatus,
  startTransition,
  validation,
  onClear,
  onDryRun,
  onSaveDraft,
  onSubmit,
}: {
  activeFid: number | null;
  composeText: string;
  isPending: boolean;
  setComposeText: (value: string) => void;
  signerStatus: SignerStatus;
  startTransition: (callback: () => void) => void;
  validation: ReturnType<typeof validateCastText>;
  onClear: () => void;
  onDryRun: () => Promise<void>;
  onSaveDraft: () => void;
  onSubmit: () => Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<"dry" | "submit" | null>(null);
  const dryRunDisabled = isPending || busyAction !== null || !activeFid || !validation.valid;
  const submitDisabled =
    dryRunDisabled || signerStatus.state !== "registered";
  const helperText = getComposerHelperText(signerStatus, validation);

  async function run(action: "dry" | "submit") {
    setBusyAction(action);
    try {
      if (action === "dry") {
        await onDryRun();
      } else {
        await onSubmit();
      }
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section className="border-b border-slate-200 px-6 py-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold">Compose</h2>
          <p className="text-xs font-medium text-slate-500">
            {activeFid ? `Signing as FID ${activeFid}` : "No signer selected"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-bold",
              signerStatusClasses(signerStatus.state),
            )}
          >
            {composerSignerStatusLabel(signerStatus.state)}
          </span>
          <span
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-bold",
              validation.valid ? "bg-moss/15 text-emerald-700" : "bg-ember/15 text-red-700",
            )}
          >
            {composeText.length}/320
          </span>
        </div>
      </div>

      <textarea
        id="compose-text"
        className="min-h-24 w-full resize-none rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-6 outline-none transition focus:border-snap focus:bg-white"
        value={composeText}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            if (!dryRunDisabled) void run("dry");
          }
        }}
        onChange={(event) => {
          const value = event.currentTarget.value;
          startTransition(() => setComposeText(value));
        }}
      />

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-slate-500">{helperText}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            type="button"
            disabled={busyAction !== null || composeText.trim().length === 0}
            onClick={onSaveDraft}
          >
            <Save className="h-4 w-4" aria-hidden="true" />
            Save
          </button>
          <button
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            type="button"
            aria-label="Clear compose"
            title="Clear compose"
            disabled={busyAction !== null || composeText.length === 0}
            onClick={onClear}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            type="button"
            disabled={dryRunDisabled}
            onClick={() => run("dry")}
          >
            {busyAction === "dry" ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Sign dry run
          </button>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md bg-ink px-3 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-50"
            type="button"
            disabled={submitDisabled}
            onClick={() => run("submit")}
          >
            {busyAction === "submit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Feather className="h-4 w-4" />}
            Submit test
          </button>
        </div>
      </div>
    </section>
  );
}

function SessionPanel({
  account,
  identityPreview,
  signerStatus,
  onApproveSigner,
  onCheckSigner,
  onDeleteSigner,
  onFocusCompose,
  setWriteResult,
}: {
  account: DesktopAccount;
  identityPreview: HypersnapUser | null;
  signerStatus: SignerStatus;
  onApproveSigner: () => Promise<boolean>;
  onCheckSigner: () => Promise<boolean>;
  onDeleteSigner: () => Promise<void>;
  onFocusCompose: () => void;
  setWriteResult: (value: string) => void;
}) {
  const [busy, setBusy] = useState<"approve" | "check" | "delete" | null>(null);
  const displayName = identityPreview ? getUserDisplayName(identityPreview) : `FID ${account.fid}`;
  const username = identityPreview ? getUserUsername(identityPreview) : `fid:${account.fid}`;

  async function run(
    action: "approve" | "check" | "delete",
    callback: () => Promise<unknown>,
  ) {
    setBusy(action);
    try {
      await callback();
    } catch (error) {
      setWriteResult(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-bold">
            <UserCheck className="h-4 w-4 text-moss" aria-hidden="true" />
            Account
          </div>
          <p className="mt-1 truncate text-xs font-medium text-slate-500">{username}</p>
        </div>
        <span
          className={cn(
            "rounded-md px-2 py-1 text-xs font-bold",
            signerStatusClasses(signerStatus.state),
          )}
        >
          {signerStatusLabel(signerStatus.state)}
        </span>
      </div>

      <div className="flex items-center gap-3 rounded-md bg-slate-50 p-3">
        {identityPreview?.pfp_url ? (
          <img
            className="h-11 w-11 flex-none rounded-md object-cover"
            src={identityPreview.pfp_url}
            alt=""
          />
        ) : (
          <div className="flex h-11 w-11 flex-none items-center justify-center rounded-md bg-ink text-sm font-bold text-snap">
            {displayName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{displayName}</p>
          <p className="truncate text-xs font-semibold text-slate-500">FID {account.fid}</p>
        </div>
      </div>

      <div
        className={cn(
          "mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-xs font-semibold",
          signerStatusClasses(signerStatus.state),
        )}
      >
        {signerStatus.state === "checking" ? (
          <Loader2 className="mt-0.5 h-4 w-4 flex-none animate-spin" aria-hidden="true" />
        ) : signerStatus.state === "registered" ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
        ) : (
          <AlertCircle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
        )}
        <p className="leading-5">{signerStatus.message}</p>
      </div>

      {signerStatus.state === "unregistered" ? (
        <ApprovalGuide
          account={account}
          busy={busy}
          onApprove={() => run("approve", onApproveSigner)}
          onCheck={() => run("check", onCheckSigner)}
          setWriteResult={setWriteResult}
        />
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-ink px-3 text-sm font-bold text-white hover:bg-slate-800"
          type="button"
          onClick={onFocusCompose}
        >
          <Feather className="h-4 w-4" aria-hidden="true" />
          Compose
        </button>
        <button
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          type="button"
          disabled={busy !== null || signerStatus.state === "checking"}
          onClick={() => run("check", onCheckSigner)}
        >
          {busy === "check" || signerStatus.state === "checking" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
          Approval
        </button>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 rounded-md bg-slate-50 p-2">
        <p className="min-w-0 truncate font-mono text-[11px] text-slate-600">
          {account.publicKeyHex}
        </p>
        <div className="flex gap-1">
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
            type="button"
            aria-label="Copy signer public key"
            title="Copy signer public key"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(account.publicKeyHex);
                setWriteResult("Copied signer public key.");
              } catch (error) {
                setWriteResult(
                  error instanceof Error ? error.message : "Unable to copy signer key.",
                );
              }
            }}
          >
            <Copy className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-red-200 bg-white text-red-700 hover:bg-red-50 disabled:opacity-50"
            type="button"
            aria-label="Delete local signer"
            title="Delete local signer"
            disabled={busy !== null}
            onClick={() => run("delete", onDeleteSigner)}
          >
            {busy === "delete" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </section>
  );
}

function ApprovalGuide({
  account,
  busy,
  onApprove,
  onCheck,
  setWriteResult,
}: {
  account: DesktopAccount;
  busy: "approve" | "check" | "delete" | null;
  onApprove: () => Promise<void>;
  onCheck: () => Promise<void>;
  setWriteResult: (value: string) => void;
}) {
  async function copySignerKey() {
    try {
      await navigator.clipboard.writeText(account.publicKeyHex);
      setWriteResult("Copied signer public key for approval.");
    } catch (error) {
      setWriteResult(
        error instanceof Error ? error.message : "Unable to copy signer key.",
      );
    }
  }

  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-950">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
        <div>
          <p className="text-xs font-bold">Approval required</p>
          <p className="mt-1 text-xs font-semibold leading-5 text-amber-900">
            Castora made a local Ed25519 signer for your FID. Use Approve now
            to sign a KEY_ADD with your saved owner key and submit it to Hypersnap.
            macOS may ask for your login keychain password.
          </p>
        </div>
      </div>

      <ol className="mt-3 space-y-2 text-xs font-semibold leading-5">
        <li className="flex gap-2">
          <span className="flex h-5 w-5 flex-none items-center justify-center rounded-md bg-white text-[11px] font-bold text-amber-800">
            1
          </span>
          Castora signs the approval locally from Keychain.
        </li>
        <li className="flex gap-2">
          <span className="flex h-5 w-5 flex-none items-center justify-center rounded-md bg-white text-[11px] font-bold text-amber-800">
            2
          </span>
          Hypersnap registers this signer for your FID.
        </li>
        <li className="flex gap-2">
          <span className="flex h-5 w-5 flex-none items-center justify-center rounded-md bg-white text-[11px] font-bold text-amber-800">
            3
          </span>
          Castora checks approval and unlocks publishing.
        </li>
      </ol>

      <div className="mt-3 rounded-md bg-white p-2">
        <p className="mb-1 text-[11px] font-bold text-amber-800">Signer public key</p>
        <p className="break-all font-mono text-[11px] leading-4 text-slate-700">
          {account.publicKeyHex}
        </p>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <button
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-white px-3 text-xs font-bold text-amber-900 hover:bg-amber-100"
          type="button"
          onClick={copySignerKey}
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
          Copy key
        </button>
        <button
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-ink px-3 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50"
          type="button"
          disabled={busy !== null}
          onClick={onApprove}
        >
          {busy === "approve" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          )}
          Approve
        </button>
        <button
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-amber-200 bg-white px-3 text-xs font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
          type="button"
          disabled={busy !== null}
          onClick={onCheck}
        >
          {busy === "check" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
          Check again
        </button>
      </div>

      <p className="mt-3 text-[11px] font-semibold leading-4 text-amber-800">
        Choose Always Allow in the macOS keychain prompt for this dev build. The
        owner key and signer key stay in the OS keychain; Castora only submits
        the signed KEY_ADD message needed to delegate desktop posting.
      </p>
    </div>
  );
}

function CommandPalette({
  commands,
  open,
  onClose,
}: {
  commands: CommandItem[];
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  if (!open) return null;

  const normalizedQuery = query.trim().toLowerCase();
  const filteredCommands = commands.filter((command) => {
    if (!normalizedQuery) return true;
    return `${command.group} ${command.label}`.toLowerCase().includes(normalizedQuery);
  });
  const groups = Array.from(new Set(filteredCommands.map((command) => command.group)));

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/20 px-4 pt-20 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-md border border-slate-200 bg-white shadow-frame">
        <div className="flex h-12 items-center gap-3 border-b border-slate-200 px-4">
          <Command className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <input
            autoFocus
            className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm font-semibold outline-none"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder="Search actions"
          />
        </div>

        <div className="max-h-[420px] overflow-y-auto p-2">
          {filteredCommands.length === 0 ? (
            <p className="rounded-md px-3 py-6 text-center text-sm font-medium text-slate-500">
              No actions found.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group} className="py-1">
                <p className="px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">
                  {group}
                </p>
                {filteredCommands
                  .filter((command) => command.group === group)
                  .map((command) => {
                    const Icon = command.icon;
                    return (
                      <button
                        key={command.id}
                        className="flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                        type="button"
                        disabled={command.disabled}
                        onClick={() => void command.action()}
                      >
                        <Icon className="h-4 w-4 text-slate-500" aria-hidden="true" />
                        {command.label}
                      </button>
                    );
                  })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function CastRow({
  cast,
  isBookmarked,
  isSelected,
  onBookmark,
  onReply,
  onSelect,
}: {
  cast: HypersnapCast;
  isBookmarked: boolean;
  isSelected: boolean;
  onBookmark: () => void;
  onReply: () => void;
  onSelect: () => void;
}) {
  const displayName = getCastDisplayName(cast);
  const username = getCastUsername(cast);
  const avatarLetter = displayName.slice(0, 1).toUpperCase();

  return (
    <li
      id={castRowId(cast.hash)}
      className={cn(
        "px-6 py-4 transition hover:bg-slate-50",
        isSelected && "bg-slate-50 shadow-[inset_3px_0_0_#17c4d8]",
      )}
    >
      <article
        className="flex cursor-pointer gap-3 outline-none"
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
      >
        {cast.author.pfp_url ? (
          <img
            className="h-11 w-11 flex-none rounded-md object-cover"
            src={cast.author.pfp_url}
            alt=""
          />
        ) : (
          <div className="flex h-11 w-11 flex-none items-center justify-center rounded-md bg-ink text-sm font-bold text-snap">
            {avatarLetter}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex min-w-0 items-center gap-2 text-sm">
            <span className="truncate font-bold">{displayName}</span>
            <span className="truncate text-slate-500">{username}</span>
            <span className="text-slate-400">·</span>
            <time className="flex-none text-slate-500">
              {new Date(cast.timestamp).toLocaleDateString()}
            </time>
          </div>
          <p className="whitespace-pre-wrap break-words text-[15px] leading-6 text-slate-900">
            {cast.text}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
            <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-1">
              <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
              {cast.replies.count}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-1">
              <Heart className="h-3.5 w-3.5" aria-hidden="true" />
              {cast.reactions.likes_count}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-1">
              <Repeat2 className="h-3.5 w-3.5" aria-hidden="true" />
              {cast.reactions.recasts_count}
            </span>
            <button
              className="ml-auto inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs font-bold text-slate-600 hover:bg-slate-100"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onReply();
              }}
            >
              <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
              Reply
            </button>
            <button
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white hover:bg-slate-100",
                isBookmarked ? "text-ember" : "text-slate-600",
              )}
              type="button"
              aria-label={isBookmarked ? "Remove bookmark" : "Bookmark cast"}
              title={isBookmarked ? "Remove bookmark" : "Bookmark cast"}
              onClick={(event) => {
                event.stopPropagation();
                onBookmark();
              }}
            >
              {isBookmarked ? (
                <BookmarkCheck className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Bookmark className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </article>
    </li>
  );
}

function CastDetailPanel({
  cast,
  isBookmarked,
  onBookmark,
  onReply,
}: {
  cast: HypersnapCast | null;
  isBookmarked: boolean;
  onBookmark: () => void;
  onReply: () => void;
}) {
  if (!cast) {
    return (
      <section className="rounded-md border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-bold">
          <MessageCircle className="h-4 w-4 text-snap" aria-hidden="true" />
          Cast detail
        </div>
        <p className="rounded-md bg-slate-50 p-3 text-xs font-medium leading-5 text-slate-500">
          Select a cast to inspect it here.
        </p>
      </section>
    );
  }

  const displayName = getCastDisplayName(cast);
  const username = getCastUsername(cast);
  const avatarLetter = displayName.slice(0, 1).toUpperCase();

  return (
    <section className="rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-bold">
          <MessageCircle className="h-4 w-4 text-snap" aria-hidden="true" />
          Cast detail
        </div>
        <button
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white hover:bg-slate-100",
            isBookmarked ? "text-ember" : "text-slate-600",
          )}
          type="button"
          aria-label={isBookmarked ? "Remove bookmark" : "Bookmark cast"}
          title={isBookmarked ? "Remove bookmark" : "Bookmark cast"}
          onClick={onBookmark}
        >
          {isBookmarked ? (
            <BookmarkCheck className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Bookmark className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>

      <div className="flex gap-3">
        {cast.author.pfp_url ? (
          <img
            className="h-11 w-11 flex-none rounded-md object-cover"
            src={cast.author.pfp_url}
            alt=""
          />
        ) : (
          <div className="flex h-11 w-11 flex-none items-center justify-center rounded-md bg-ink text-sm font-bold text-snap">
            {avatarLetter}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{displayName}</p>
          <p className="truncate text-xs font-medium text-slate-500">{username}</p>
        </div>
      </div>

      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-900">
        {cast.text || "(empty cast)"}
      </p>

      <div className="mt-4 grid grid-cols-3 gap-2 rounded-md bg-slate-50 p-2 text-center text-xs font-semibold text-slate-600">
        <span>
          <strong className="block text-sm text-slate-950">{cast.replies.count}</strong>
          Replies
        </span>
        <span>
          <strong className="block text-sm text-slate-950">
            {cast.reactions.likes_count}
          </strong>
          Likes
        </span>
        <span>
          <strong className="block text-sm text-slate-950">
            {cast.reactions.recasts_count}
          </strong>
          Recasts
        </span>
      </div>

      <div className="mt-3 flex">
        <button
          className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md bg-ink px-3 text-sm font-bold text-white hover:bg-slate-800"
          type="button"
          onClick={onReply}
        >
          <MessageCircle className="h-4 w-4" aria-hidden="true" />
          Reply draft
        </button>
      </div>

      <p className="mt-3 break-all rounded-md bg-slate-950 p-2 font-mono text-[11px] leading-4 text-slate-100">
        {cast.hash}
      </p>
    </section>
  );
}

function DraftsPanel({
  drafts,
  onDeleteDraft,
  onLoadDraft,
}: {
  drafts: SavedDraft[];
  onDeleteDraft: (id: string) => void;
  onLoadDraft: (draft: SavedDraft) => void;
}) {
  return (
    <section className="mt-4 rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-bold">
          <Bookmark className="h-4 w-4 text-ember" aria-hidden="true" />
          Drafts
        </div>
        <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-bold text-slate-500">
          {drafts.length}
        </span>
      </div>

      {drafts.length === 0 ? (
        <p className="rounded-md bg-slate-50 p-3 text-xs font-medium leading-5 text-slate-500">
          Saved casts will appear here.
        </p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {drafts.slice(0, 6).map((draft) => (
            <li key={draft.id} className="py-3 first:pt-0 last:pb-0">
              <button
                className="block w-full rounded-md text-left hover:bg-slate-50"
                type="button"
                onClick={() => onLoadDraft(draft)}
              >
                <p className="max-h-10 overflow-hidden px-2 pt-2 text-sm font-semibold leading-5 text-slate-800">
                  {draft.text}
                </p>
              </button>
              <div className="mt-2 flex items-center justify-between gap-2 px-2">
                <span className="text-xs font-medium text-slate-500">
                  {draft.fid ? `FID ${draft.fid}` : "No FID"} · {formatDraftDate(draft.createdAt)}
                </span>
                <button
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-red-50 hover:text-red-700"
                  type="button"
                  aria-label="Delete draft"
                  title="Delete draft"
                  onClick={() => onDeleteDraft(draft.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SettingsPanel({
  draft,
  onChange,
  onSave,
}: {
  draft: DesktopSettings;
  onChange: (settings: DesktopSettings) => void;
  onSave: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await onSave();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-4 rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-bold">
        <Settings className="h-4 w-4 text-slate-500" aria-hidden="true" />
        Network settings
      </div>
      <label className="block text-xs font-bold text-slate-500" htmlFor="node-url">
        Hypersnap node URL
      </label>
      <input
        id="node-url"
        className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-snap"
        value={draft.nodeBaseUrl}
        onChange={(event) => onChange({ ...draft, nodeBaseUrl: event.currentTarget.value })}
      />

      <label className="mt-3 block text-xs font-bold text-slate-500" htmlFor="hub-url">
        Hub submit URL
      </label>
      <input
        id="hub-url"
        className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-snap"
        value={draft.hubSubmitUrl}
        onChange={(event) => onChange({ ...draft, hubSubmitUrl: event.currentTarget.value })}
      />

      <button
        className="mt-3 h-9 w-full rounded-md bg-slate-900 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-50"
        type="button"
        disabled={saving}
        onClick={save}
      >
        {saving ? "Saving..." : "Save settings"}
      </button>
    </section>
  );
}

function signerStatusLabel(state: SignerStatusState) {
  switch (state) {
    case "registered":
      return "Registered";
    case "checking":
      return "Checking";
    case "unregistered":
      return "Approval required";
    case "error":
      return "Check failed";
    case "idle":
    default:
      return "No signer";
  }
}

function composerSignerStatusLabel(state: SignerStatusState) {
  if (state === "unregistered") return "Local signer";
  return signerStatusLabel(state);
}

function getComposerHelperText(
  signerStatus: SignerStatus,
  validation: ReturnType<typeof validateCastText>,
) {
  if (!validation.valid) return validation.reason;

  switch (signerStatus.state) {
    case "registered":
      return "Signer approved. You can publish from Castora Desktop.";
    case "unregistered":
      return "Drafting and dry signing work locally. Publishing waits for signer approval.";
    case "checking":
      return "Checking whether this local signer is approved for your FID.";
    case "error":
      return signerStatus.message;
    case "idle":
    default:
      return "Connect an account to create a local desktop signer.";
  }
}

function signerStatusClasses(state: SignerStatusState) {
  switch (state) {
    case "registered":
      return "bg-moss/15 text-emerald-700";
    case "checking":
      return "bg-snap/15 text-cyan-700";
    case "unregistered":
      return "bg-amber-100 text-amber-800";
    case "error":
      return "bg-ember/15 text-red-700";
    case "idle":
    default:
      return "bg-slate-100 text-slate-600";
  }
}

function isSavedDraft(value: unknown): value is SavedDraft {
  if (!value || typeof value !== "object") return false;

  const draft = value as Partial<SavedDraft>;
  return (
    typeof draft.id === "string" &&
    typeof draft.text === "string" &&
    typeof draft.createdAt === "string" &&
    (typeof draft.fid === "number" || draft.fid === null)
  );
}

function formatDraftDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getCastDisplayName(cast: HypersnapCast) {
  return cast.author.display_name || cast.author.username || `FID ${cast.author.fid}`;
}

function getCastUsername(cast: HypersnapCast) {
  return cast.author.username ? `@${cast.author.username}` : `fid:${cast.author.fid}`;
}

function getUserDisplayName(user: HypersnapUser) {
  return user.display_name || user.username || `FID ${user.fid}`;
}

function getUserUsername(user: HypersnapUser) {
  return user.username ? `@${user.username}` : `fid:${user.fid}`;
}

function castRowId(hash: string) {
  return `cast-row-${hash.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  });
}

function isTextEntryActive() {
  const activeElement = document.activeElement;

  if (!activeElement) return false;

  return (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement ||
    activeElement.getAttribute("contenteditable") === "true"
  );
}

export default App;
