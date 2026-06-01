import { useEffect, useMemo, useState, useTransition } from "react";
import {
  AlertCircle,
  ArrowRight,
  Bell,
  Bookmark,
  BookmarkCheck,
  CheckCircle2,
  CircleDot,
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
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import "./App.css";
import {
  DEFAULT_SETTINGS,
  fetchSignerEvents,
  fetchTrendingFeed,
  isSignerRegistered,
  type HypersnapCast,
} from "./lib/hypersnap";
import {
  createSigner,
  deleteSigner,
  getAccount,
  getSettings,
  importSigner,
  saveSettings,
  type DesktopAccount,
  type DesktopSettings,
} from "./lib/tauri";
import { buildSignedCastAdd, submitRawMessage, validateCastText } from "./lib/farcaster";
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
const FIRST_CAST_STORAGE_KEY = "castora-desktop:first-cast-complete";

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

type SetupStepStatus = "done" | "current" | "pending" | "blocked";

type PrimaryOnboardingAction =
  | { kind: "focus-fid"; label: string; disabled: boolean }
  | { kind: "create-signer"; label: string; disabled: boolean }
  | { kind: "check-signer"; label: string; disabled: boolean }
  | { kind: "focus-compose"; label: string; disabled: boolean }
  | { kind: "complete"; label: string; disabled: boolean };

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
  const [privateKeyInput, setPrivateKeyInput] = useState("");
  const [writeResult, setWriteResult] = useState("");
  const [settingsDraft, setSettingsDraft] = useState<DesktopSettings>(DEFAULT_SETTINGS);
  const [signerStatus, setSignerStatus] = useState<SignerStatus>(emptySignerStatus);
  const [savedDrafts, setSavedDrafts] = useState<SavedDraft[]>([]);
  const [bookmarkedCastHashes, setBookmarkedCastHashes] = useState<string[]>([]);
  const [selectedCastHash, setSelectedCastHash] = useState<string | null>(null);
  const [firstCastSubmitted, setFirstCastSubmitted] = useState(false);
  const [isPending, startTransition] = useTransition();

  const castValidation = useMemo(() => validateCastText(composeText), [composeText]);
  const activeFid = account?.fid ?? settings.selectedFid ?? null;
  const parsedFidInput = Number(fidInput);
  const fidCandidate = activeFid ?? (parsedFidInput > 0 ? parsedFidInput : null);
  const selectedCast = useMemo(
    () => casts.find((cast) => cast.hash === selectedCastHash) ?? casts[0] ?? null,
    [casts, selectedCastHash],
  );

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const [storedSettings, storedAccount] = await Promise.all([
        getSettings(),
        getAccount(),
      ]);

      if (cancelled) return;

      setSettings(storedSettings);
      setSettingsDraft(storedSettings);
      setAccount(storedAccount);
      setFidInput(storedAccount?.fid ? String(storedAccount.fid) : "");
    }

    bootstrap().catch((error) => {
      setWriteResult(`Startup warning: ${String(error)}`);
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
    setFirstCastSubmitted(window.localStorage.getItem(FIRST_CAST_STORAGE_KEY) === "true");
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
    if (casts.length === 0) {
      setSelectedCastHash(null);
      return;
    }

    if (!selectedCastHash || !casts.some((cast) => cast.hash === selectedCastHash)) {
      setSelectedCastHash(casts[0].hash);
    }
  }, [casts, selectedCastHash]);

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
      const events = await fetchSignerEvents(nodeBaseUrl, targetAccount.fid);
      const registered = isSignerRegistered(events, targetAccount.publicKeyHex);

      setSignerStatus({
        state: registered ? "registered" : "unregistered",
        eventCount: events.length,
        checkedAt: new Date().toISOString(),
        message: registered
          ? "This desktop signer is approved for writes."
          : "This local signer is not approved on KeyRegistry yet.",
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

  async function handleCreateSigner() {
    const fid = Number(fidInput);
    const nextAccount = await createSigner(fid);
    const savedSettings = await saveSettings({ ...settings, selectedFid: fid });
    setAccount(nextAccount);
    setSettings(savedSettings);
    setSettingsDraft((current) => ({ ...current, selectedFid: fid }));
    setSignerStatus({
      state: "unregistered",
      eventCount: 0,
      message: "Created locally. Approve this signer before submitting writes.",
    });
    setWriteResult(
      `Created local desktop signer ${nextAccount.publicKeyHex.slice(0, 18)}... for FID ${fid}. Approve this signer before submitting writes.`,
    );
  }

  async function handleImportSigner() {
    const fid = Number(fidInput);
    const nextAccount = await importSigner(fid, privateKeyInput);
    const savedSettings = await saveSettings({ ...settings, selectedFid: fid });
    setAccount(nextAccount);
    setPrivateKeyInput("");
    setSettings(savedSettings);
    setSettingsDraft((current) => ({ ...current, selectedFid: fid }));
    setWriteResult(`Imported signer for FID ${fid}.`);
    void checkSignerReadiness(nextAccount, savedSettings.nodeBaseUrl);
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
      setWriteResult("Signer must be approved on KeyRegistry before submitting.");
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
    if (result.ok) {
      setFirstCastSubmitted(true);
      window.localStorage.setItem(FIRST_CAST_STORAGE_KEY, "true");
    }
    setWriteResult(
      `Submitted ${signed.hashHex.slice(0, 18)}... with HTTP ${result.status}: ${result.body.slice(0, 180)}`,
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
              Local signer
            </div>
            <p className="text-xs leading-5 text-slate-500">
              Secrets live in the OS keychain. The web UI can ask for signatures but
              never receives private keys.
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
          <OnboardingPanel
            account={account}
            feedStatus={feedStatus}
            fidCandidate={fidCandidate}
            firstCastSubmitted={firstCastSubmitted}
            signerStatus={signerStatus}
            onCheckSigner={() => checkSignerReadiness(account)}
            onCreateSigner={handleCreateSigner}
            onFocusCompose={() => focusField("compose-text")}
            onFocusFid={() => focusField("fid")}
            onReport={setWriteResult}
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

          <AccountPanel
            account={account}
            fidInput={fidInput}
            privateKeyInput={privateKeyInput}
            setFidInput={setFidInput}
            setPrivateKeyInput={setPrivateKeyInput}
            onCreateSigner={handleCreateSigner}
            onCheckSigner={() => checkSignerReadiness(account)}
            onImportSigner={handleImportSigner}
            onDeleteSigner={handleDeleteSigner}
            signerStatus={signerStatus}
            setWriteResult={setWriteResult}
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
              Write spike
            </div>
            <p className="min-h-20 rounded-md bg-slate-950 p-3 text-xs leading-5 text-slate-100">
              {writeResult || "Create/import a signer, build a signed cast message, then submit only with a test FID first."}
            </p>
          </div>
        </aside>
      </div>
    </main>
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
            {signerStatusLabel(signerStatus.state)}
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
        <p className="text-xs font-medium text-slate-500">
          {validation.valid ? signerStatus.message : validation.reason}
        </p>
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

function OnboardingPanel({
  account,
  feedStatus,
  fidCandidate,
  firstCastSubmitted,
  signerStatus,
  onCheckSigner,
  onCreateSigner,
  onFocusCompose,
  onFocusFid,
  onReport,
}: {
  account: DesktopAccount | null;
  feedStatus: "idle" | "loading" | "ready" | "error";
  fidCandidate: number | null;
  firstCastSubmitted: boolean;
  signerStatus: SignerStatus;
  onCheckSigner: () => Promise<boolean>;
  onCreateSigner: () => Promise<void>;
  onFocusCompose: () => void;
  onFocusFid: () => void;
  onReport: (message: string) => void;
}) {
  const [busyAction, setBusyAction] = useState<"create" | "check" | null>(null);
  const steps = [
    {
      title: "Live feed",
      detail:
        feedStatus === "ready"
          ? "Hypersnap reads are online."
          : feedStatus === "error"
            ? "Using local fallback while the node recovers."
            : "Connecting to Hypersnap.",
      done: feedStatus === "ready",
    },
    {
      title: "Existing FID",
      detail: fidCandidate ? `FID ${fidCandidate} selected.` : "Choose the identity to use.",
      done: fidCandidate !== null,
    },
    {
      title: "Desktop signer",
      detail: account?.hasSigner ? "Signer is stored locally." : "Create or import a local signer.",
      done: Boolean(account?.hasSigner),
    },
    {
      title: "Approval",
      detail: signerStatus.message,
      done: signerStatus.state === "registered",
    },
    {
      title: "First cast",
      detail: firstCastSubmitted ? "First desktop cast sent." : "Write, sign, and submit.",
      done: firstCastSubmitted,
    },
  ];
  const firstOpenStep = steps.findIndex((step) => !step.done);
  const completedCount = steps.filter((step) => step.done).length;
  const primaryAction = getOnboardingPrimaryAction({
    account,
    fidCandidate,
    firstCastSubmitted,
    signerStatus,
  });

  async function runPrimaryAction() {
    if (primaryAction.kind === "focus-fid") {
      onFocusFid();
      return;
    }

    if (primaryAction.kind === "focus-compose") {
      onFocusCompose();
      return;
    }

    if (primaryAction.kind === "complete") {
      onFocusCompose();
      return;
    }

    const action = primaryAction.kind === "create-signer" ? "create" : "check";
    setBusyAction(action);

    try {
      if (primaryAction.kind === "create-signer") {
        await onCreateSigner();
      } else {
        await onCheckSigner();
      }
    } catch (error) {
      onReport(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section className="mb-4 rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold">
            <ListChecks className="h-4 w-4 text-snap" aria-hidden="true" />
            First cast setup
          </div>
          <p className="mt-1 text-xs font-medium text-slate-500">
            {completedCount}/{steps.length} ready
          </p>
        </div>
        <span
          className={cn(
            "rounded-md px-2 py-1 text-xs font-bold",
            firstCastSubmitted ? "bg-moss/15 text-emerald-700" : "bg-slate-100 text-slate-600",
          )}
        >
          {firstCastSubmitted ? "Ready" : "Setup"}
        </span>
      </div>

      <ol className="space-y-2">
        {steps.map((step, index) => {
          const status = getSetupStepStatus(step.done, index, firstOpenStep);
          return (
            <li
              key={step.title}
              className={cn(
                "flex gap-2 rounded-md border px-3 py-2",
                setupStepClasses(status),
              )}
            >
              <SetupStepIcon status={status} />
              <div className="min-w-0">
                <p className="text-xs font-bold">{step.title}</p>
                <p className="mt-0.5 text-xs font-medium leading-4 opacity-75">
                  {step.detail}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      <button
        className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-ink px-3 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-50"
        type="button"
        disabled={primaryAction.disabled || busyAction !== null}
        onClick={runPrimaryAction}
      >
        {busyAction ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        )}
        {busyAction === "create"
          ? "Creating..."
          : busyAction === "check"
            ? "Checking..."
            : primaryAction.label}
      </button>
    </section>
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

function AccountPanel({
  account,
  fidInput,
  privateKeyInput,
  setFidInput,
  setPrivateKeyInput,
  onCreateSigner,
  onCheckSigner,
  onImportSigner,
  onDeleteSigner,
  signerStatus,
  setWriteResult,
}: {
  account: DesktopAccount | null;
  fidInput: string;
  privateKeyInput: string;
  setFidInput: (value: string) => void;
  setPrivateKeyInput: (value: string) => void;
  onCreateSigner: () => Promise<void>;
  onCheckSigner: () => Promise<boolean>;
  onImportSigner: () => Promise<void>;
  onDeleteSigner: () => Promise<void>;
  signerStatus: SignerStatus;
  setWriteResult: (value: string) => void;
}) {
  const [busy, setBusy] = useState<"create" | "import" | "delete" | "check" | null>(
    null,
  );

  async function run(
    action: "create" | "import" | "delete" | "check",
    callback: () => Promise<unknown>,
  ) {
    setBusy(action);
    try {
      await callback();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-bold">
          <KeyRound className="h-4 w-4 text-snap" aria-hidden="true" />
          Account
        </div>
        {account ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-moss/15 px-2 py-1 text-xs font-bold text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            FID {account.fid}
          </span>
        ) : null}
      </div>

      <div
        className={cn(
          "mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-xs font-semibold",
          signerStatusClasses(signerStatus.state),
        )}
      >
        {signerStatus.state === "registered" ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
        ) : signerStatus.state === "checking" ? (
          <Loader2 className="mt-0.5 h-4 w-4 flex-none animate-spin" aria-hidden="true" />
        ) : (
          <AlertCircle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
        )}
        <div>
          <p>{signerStatusLabel(signerStatus.state)}</p>
          <p className="mt-0.5 font-medium opacity-80">{signerStatus.message}</p>
        </div>
      </div>

      <label className="block text-xs font-bold text-slate-500" htmlFor="fid">
        Existing FID
      </label>
      <input
        id="fid"
        className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-snap"
        inputMode="numeric"
        value={fidInput}
        onChange={(event) => setFidInput(event.currentTarget.value)}
        placeholder="12345"
      />

      <label className="mt-3 block text-xs font-bold text-slate-500" htmlFor="signer-key">
        Import signer seed hex
      </label>
      <input
        id="signer-key"
        className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-snap"
        value={privateKeyInput}
        onChange={(event) => setPrivateKeyInput(event.currentTarget.value)}
        placeholder="0x..."
        type="password"
      />

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          className="h-9 rounded-md bg-ink px-3 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-50"
          type="button"
          disabled={busy !== null || !Number(fidInput)}
          onClick={() => run("create", onCreateSigner)}
        >
          {busy === "create" ? "Creating..." : "Create signer"}
        </button>
        <button
          className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          type="button"
          disabled={busy !== null || !Number(fidInput) || privateKeyInput.length < 32}
          onClick={() => run("import", onImportSigner)}
        >
          {busy === "import" ? "Importing..." : "Import"}
        </button>
      </div>

      {account ? (
        <div className="mt-3 rounded-md bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold text-slate-500">Signer public key</p>
            <div className="flex gap-1">
              <button
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                type="button"
                aria-label="Copy signer public key"
                title="Copy signer public key"
                disabled={busy !== null}
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
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                type="button"
                aria-label="Check signer approval"
                title="Check signer approval"
                disabled={busy !== null || signerStatus.state === "checking"}
                onClick={() => run("check", onCheckSigner)}
              >
                {busy === "check" || signerStatus.state === "checking" ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
          <p className="mt-1 break-all font-mono text-xs text-slate-700">{account.publicKeyHex}</p>
          <button
            className="mt-3 h-8 rounded-md border border-red-200 bg-white px-3 text-xs font-bold text-red-700 hover:bg-red-50"
            type="button"
            disabled={busy !== null}
            onClick={() => run("delete", onDeleteSigner)}
          >
            Delete local signer
          </button>
        </div>
      ) : null}
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

function SetupStepIcon({ status }: { status: SetupStepStatus }) {
  if (status === "done") {
    return <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />;
  }

  if (status === "current") {
    return <CircleDot className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />;
  }

  if (status === "blocked") {
    return <AlertCircle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />;
  }

  return <CircleDot className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />;
}

function getSetupStepStatus(
  done: boolean,
  index: number,
  firstOpenStep: number,
): SetupStepStatus {
  if (done) return "done";
  if (index === firstOpenStep) return "current";
  if (firstOpenStep === -1 || index < firstOpenStep) return "pending";
  return "blocked";
}

function setupStepClasses(status: SetupStepStatus) {
  switch (status) {
    case "done":
      return "border-emerald-100 bg-moss/10 text-emerald-700";
    case "current":
      return "border-cyan-100 bg-snap/10 text-cyan-800";
    case "blocked":
      return "border-slate-100 bg-slate-50 text-slate-400";
    case "pending":
    default:
      return "border-slate-100 bg-slate-50 text-slate-600";
  }
}

function getOnboardingPrimaryAction({
  account,
  fidCandidate,
  firstCastSubmitted,
  signerStatus,
}: {
  account: DesktopAccount | null;
  fidCandidate: number | null;
  firstCastSubmitted: boolean;
  signerStatus: SignerStatus;
}): PrimaryOnboardingAction {
  if (!fidCandidate) {
    return { kind: "focus-fid", label: "Enter existing FID", disabled: false };
  }

  if (!account?.hasSigner) {
    return { kind: "create-signer", label: "Create local signer", disabled: false };
  }

  if (signerStatus.state !== "registered") {
    return {
      kind: "check-signer",
      label: signerStatus.state === "checking" ? "Checking approval" : "Check approval",
      disabled: signerStatus.state === "checking",
    };
  }

  if (!firstCastSubmitted) {
    return { kind: "focus-compose", label: "Compose first cast", disabled: false };
  }

  return { kind: "complete", label: "Write another cast", disabled: false };
}

function signerStatusLabel(state: SignerStatusState) {
  switch (state) {
    case "registered":
      return "Registered";
    case "checking":
      return "Checking";
    case "unregistered":
      return "Needs approval";
    case "error":
      return "Check failed";
    case "idle":
    default:
      return "No signer";
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

export default App;
