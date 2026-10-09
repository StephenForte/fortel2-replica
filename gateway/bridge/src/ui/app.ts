/**
 * /bridge controller. Approve is computed from the live wallet, the live
 * form, and the clock. A quote isQuoteValid rejects is dropped, not kept.
 * Progress steps turn done only after tracker.refresh in this page session.
 */

import { parseEthAmount, validateRecipient } from "../bridge-protocol";
import { loadConfig, verifyConfig } from "../config";
import { submitDeposit } from "../deposit";
import { createJournal, type Journal, type JournalStorage } from "../journal";
import { createQuote, isQuoteValid, type QuoteContext } from "../quote";
import { L1_READ, L2_READ, createRpcClient, type RpcClient } from "../rpc";
import { createPoller, createTracker, type Poller, type PollerTimer, type Tracker } from "../tracker";
import type { BridgeConfig, DepositQuote, DepositRecord } from "../types";
import {
  createWallet,
  discoverMetaMask,
  type DiscoveryTarget,
  type DiscoveryTimer,
  type Eip1193Provider,
  type Wallet,
} from "../wallet";
import { clear, el, requireElement, setText } from "./dom";
import { formatEth, formatEthLabel, secondsUntil, transferredPrincipalWei } from "./format";
import { historyPhase, renderProgressArticle } from "./progress";

const GUIDANCE =
  "MetaMask extension on desktop Chrome or Brave is required. In Brave, set MetaMask as the default wallet.";
const RPC_TIMEOUT_MS = 20_000;

type BalanceView = {
  text: string;
  at: number | null;
  error: string;
};

export type BridgeStart = {
  target?: DiscoveryTarget;
  timer?: DiscoveryTimer;
  windowMs?: number;
  now?: () => number;
  every?: (ms: number, fn: () => void) => () => void;
  storage?: JournalStorage | null;
  pollerTimer?: PollerTimer;
  doc?: Document;
};

export type BridgeHandle = {
  tick(): void;
};

const emptyBalance = (): BalanceView => ({ text: "–", at: null, error: "" });

export async function startBridge(options: BridgeStart = {}): Promise<BridgeHandle> {
  const now = options.now ?? (() => Date.now());
  const every = options.every ?? defaultEvery;
  const doc = options.doc ?? document;
  const storage = options.storage === undefined ? window.localStorage : options.storage;

  const live = requireElement<HTMLElement>("live");
  const guidance = requireElement<HTMLElement>("wallet-guidance");
  const configStatus = requireElement<HTMLElement>("config-status");
  const connectButton = requireElement<HTMLButtonElement>("connect");
  const amountInput = requireElement<HTMLInputElement>("amount");
  const recipientInput = requireElement<HTMLInputElement>("recipient");
  const amountError = requireElement<HTMLElement>("amount-error");
  const recipientError = requireElement<HTMLElement>("recipient-error");
  const reviewButton = requireElement<HTMLButtonElement>("review");
  const approveButton = requireElement<HTMLButtonElement>("approve");
  const reviewPanel = requireElement<HTMLElement>("review-panel");
  const depositResult = requireElement<HTMLElement>("deposit-result");
  const uncertain = requireElement<HTMLElement>("uncertain-recovery");
  const pasteHash = requireElement<HTMLInputElement>("paste-hash");
  const historyStatus = requireElement<HTMLElement>("history-status");
  const importResult = requireElement<HTMLElement>("import-result");
  const clearConfirm = requireElement<HTMLElement>("clear-confirm");
  const presets = requireElement<HTMLElement>("presets");
  const progressList = requireElement<HTMLElement>("progress-list");
  const historyList = requireElement<HTMLElement>("history-list");

  let cfg: BridgeConfig | null = null;
  let configState: "loading" | "ok" | "mismatch" | "unavailable" = "loading";
  let provider: Eip1193Provider | null = null;
  let wallet: Wallet | null = null;
  let account: string | null = null;
  let chainId: string | null = null;
  let recipientTouched = false;
  let sepoliaBalance = emptyBalance();
  let forteBalance = emptyBalance();
  let quote: DepositQuote | null = null;
  let submitting = false;
  let reviewing = false;
  let journal: Journal | null = null;
  let tracker: Tracker | null = null;
  let poller: Poller | null = null;
  let l1: RpcClient | null = null;
  let sequencer: RpcClient | null = null;
  let replica: RpcClient | null = null;
  const proven = new Map<string, DepositRecord>();

  function setStatus(message: string): void {
    live.textContent = message;
  }

  function clientsReady(): boolean {
    return cfg !== null && l1 !== null && sequencer !== null && replica !== null;
  }

  function liveCtx(): QuoteContext | null {
    if (!cfg || !account || chainId === null) return null;
    let amountWei: bigint;
    try {
      amountWei = parseEthAmount(amountInput.value.trim(), BigInt(cfg.deposit.capWei));
    } catch {
      return null;
    }
    let recipient: string;
    try {
      recipient = validateRecipient(recipientInput.value.trim());
    } catch {
      return null;
    }
    return {
      account,
      chainId,
      recipient,
      amountWei: amountWei.toString(10),
      configVersion: cfg.configVersion,
    };
  }

  function quoteStillValid(): boolean {
    if (!quote) return false;
    const ctx = liveCtx();
    if (!ctx) return false;
    return isQuoteValid(quote, ctx, now());
  }

  function dropQuote(): void {
    quote = null;
    reviewPanel.hidden = true;
    for (const id of [
      "review-source",
      "review-destination",
      "review-recipient",
      "review-amount",
      "review-gas",
      "review-fee",
      "review-debit",
      "review-countdown",
    ]) {
      setText(id, "");
    }
    syncButtons();
  }

  function invalidateReview(message: string): void {
    const had = quote !== null;
    if (had) dropQuote();
    if (had) setStatus(message);
    syncButtons();
  }

  function canReview(): boolean {
    return configState === "ok" && account !== null && wallet !== null && !submitting && !reviewing && amountOk() && recipientOk();
  }

  function canApprove(): boolean {
    return configState === "ok" && !submitting && quoteStillValid();
  }

  function syncButtons(): void {
    reviewButton.disabled = !canReview();
    approveButton.disabled = !canApprove();
  }

  function amountOk(): boolean {
    if (!cfg) return false;
    try {
      parseEthAmount(amountInput.value.trim(), BigInt(cfg.deposit.capWei));
      return true;
    } catch {
      return false;
    }
  }

  function recipientOk(): boolean {
    try {
      validateRecipient(recipientInput.value.trim());
      return true;
    } catch {
      return false;
    }
  }

  function showFieldErrors(): void {
    if (!cfg) {
      amountError.textContent = "";
    } else {
      try {
        parseEthAmount(amountInput.value.trim(), BigInt(cfg.deposit.capWei));
        amountError.textContent = "";
      } catch (err) {
        amountError.textContent = err instanceof Error ? err.message : "Amount is invalid.";
      }
    }
    const raw = recipientInput.value.trim();
    if (raw === "") {
      recipientError.textContent = recipientTouched ? "Recipient is required." : "";
    } else {
      try {
        validateRecipient(raw);
        recipientError.textContent = "";
      } catch (err) {
        recipientError.textContent = err instanceof Error ? err.message : "Recipient is invalid.";
      }
    }
  }

  function renderBalances(): void {
    setText("sepolia-balance", sepoliaBalance.text);
    setText("sepolia-balance-time", sepoliaBalance.at === null ? "–" : new Date(sepoliaBalance.at).toISOString());
    setText("sepolia-balance-error", sepoliaBalance.error);
    setText("forte-balance", forteBalance.text);
    setText("forte-balance-time", forteBalance.at === null ? "–" : new Date(forteBalance.at).toISOString());
    setText("forte-balance-error", forteBalance.error);
    setText("account", account ?? "Not connected");
  }

  function updateCountdown(): void {
    if (!quote) return;
    const left = secondsUntil(quote.expiresAt, now());
    setText("review-countdown", `Expires in ${left}s`);
  }

  function renderReview(current: DepositQuote): void {
    reviewPanel.hidden = false;
    if (!cfg) return;
    setText("review-source", cfg.l1.name);
    setText("review-destination", `${cfg.l2.name} (${cfg.l2.chainId})`);
    setText("review-recipient", current.recipient);
    setText("review-amount", formatEthLabel(current.amountWei));
    setText("review-gas", current.l1GasEstimate);
    setText("review-fee", formatEthLabel(current.maxNetworkFeeWei));
    setText("review-debit", formatEthLabel(current.maxWalletDebitWei));
    updateCountdown();
  }

  function sortedRecords(): DepositRecord[] {
    if (!journal) return [];
    return journal
      .list()
      .map((record, index) => ({ record, index }))
      .sort((a, b) => {
        const left = a.record.submittedAt ?? a.record.approvedAt ?? 0;
        const right = b.record.submittedAt ?? b.record.approvedAt ?? 0;
        if (right !== left) return right - left;
        return b.index - a.index;
      })
      .map((item) => item.record);
  }

  function renderProgress(): void {
    clear(progressList);
    if (!cfg) return;
    for (const record of sortedRecords()) {
      const session = proven.get(record.l1Hash.toLowerCase()) ?? null;
      renderProgressArticle(progressList, record, session, cfg);
    }
  }

  function renderHistory(): void {
    clear(historyList);
    const records = sortedRecords();
    const fees = journal ? journal.totalActualFeesWei() : "0";
    setText("fee-total-value", formatEthLabel(fees));
    setText("principal-total-value", formatEthLabel(transferredPrincipalWei(records)));
    for (const record of records) {
      const session = proven.get(record.l1Hash.toLowerCase()) ?? null;
      const row = el("article", { className: "history-row" });
      row.dataset.l1Hash = record.l1Hash;
      const lines = [
        `Recipient ${record.recipient}`,
        `Amount ${formatEthLabel(record.amountWei)}`,
        `Phase ${historyPhase(session)}`,
        `Actual L1 fee ${record.actualL1FeeWei ? formatEthLabel(record.actualL1FeeWei) : "none"}`,
      ];
      for (const line of lines) row.append(el("p", { className: "wrap", text: line }));
      const hash = el("p", { className: "hash", text: record.l1Hash });
      row.append(hash);
      historyList.append(row);
    }
  }

  function renderAll(): void {
    showFieldErrors();
    renderBalances();
    if (quote && quoteStillValid()) renderReview(quote);
    renderProgress();
    renderHistory();
    syncButtons();
  }

  function tick(): void {
    if (quote && !quoteStillValid()) {
      dropQuote();
      setStatus("The review expired. Review the deposit again.");
    } else if (quote) {
      updateCountdown();
    }
    syncButtons();
  }

  async function readChain(): Promise<void> {
    if (!provider) {
      chainId = null;
      return;
    }
    try {
      const value = await provider.request({ method: "eth_chainId", params: [] });
      chainId = typeof value === "string" ? value : null;
    } catch {
      chainId = null;
    }
  }

  async function runVerify(): Promise<void> {
    if (!cfg || !l1 || !sequencer || !replica || !provider) {
      configState = "unavailable";
      configStatus.textContent = "network check unavailable";
      syncButtons();
      return;
    }
    const result = await verifyConfig({ cfg, l1, sequencer, replica, wallet: provider });
    if (result.ok) {
      configState = "ok";
      configStatus.textContent = "Network check matches this bridge.";
    } else if ("unavailable" in result) {
      configState = "unavailable";
      configStatus.textContent = "network check unavailable";
    } else {
      configState = "mismatch";
      configStatus.textContent = result.reason;
    }
    if (configState !== "ok") dropQuote();
    syncButtons();
  }

  async function refreshSepoliaBalance(): Promise<void> {
    const current = account;
    if (!provider || !current) {
      sepoliaBalance = emptyBalance();
      renderBalances();
      return;
    }
    const at = now();
    try {
      const raw = await provider.request({ method: "eth_getBalance", params: [current, "latest"] });
      if (account !== current) return;
      sepoliaBalance = { text: formatEthLabel(parseQuantity(raw)), at, error: "" };
    } catch {
      if (account !== current) return;
      sepoliaBalance = { text: "–", at, error: "Sepolia balance unavailable" };
    }
    renderBalances();
  }

  async function refreshForteBalance(): Promise<void> {
    const recipientRaw = recipientInput.value.trim();
    const who = recipientRaw || account;
    if (!replica || !who) {
      forteBalance = emptyBalance();
      renderBalances();
      return;
    }
    let recipient = who;
    try {
      recipient = validateRecipient(who);
    } catch {
      forteBalance = { text: "–", at: now(), error: "ForteL2 balance unavailable" };
      renderBalances();
      return;
    }
    const at = now();
    try {
      const raw = await replica.call("eth_getBalance", [recipient, "latest"]);
      if ((recipientInput.value.trim() || account) !== who && recipientInput.value.trim() !== recipientRaw) return;
      forteBalance = { text: formatEthLabel(parseQuantity(raw)), at, error: "" };
    } catch {
      forteBalance = { text: "–", at, error: "ForteL2 balance unavailable" };
    }
    renderBalances();
  }

  function closeJournal(): void {
    if (journal && poller) {
      for (const record of journal.list()) poller.unwatch(record.l1Hash);
    }
    poller?.stop();
    poller = null;
    tracker = null;
    journal = null;
    proven.clear();
  }

  function openJournal(nextAccount: string): void {
    if (!cfg || !l1 || !sequencer || !replica) return;
    poller?.stop();
    proven.clear();
    journal = createJournal({ storage, cfg, account: nextAccount });
    tracker = createTracker({ cfg, l1, sequencer, replica, now });
    const visibility = {
      get visibilityState() {
        return doc.visibilityState;
      },
      addEventListener(_type: "visibilitychange", listener: () => void) {
        doc.addEventListener("visibilitychange", listener);
      },
      removeEventListener(_type: "visibilitychange", listener: () => void) {
        doc.removeEventListener("visibilitychange", listener);
      },
    };
    poller = createPoller({
      tracker,
      intervalMs: cfg.deposit.pollSeconds * 1000,
      visibility,
      now,
      ...(options.pollerTimer ? { timer: options.pollerTimer } : {}),
      onUpdate(record) {
        proven.set(record.l1Hash.toLowerCase(), record);
        journal?.upsert(record);
        renderProgress();
        renderHistory();
      },
    });
    for (const record of journal.list()) poller.watch(record);
    poller.start();
    renderProgress();
    renderHistory();
  }

  function showSubmitted(record: DepositRecord): void {
    clear(depositResult);
    const line = el("p", { className: "wrap" });
    line.append(el("span", { text: "Submitted " }));
    if (cfg) {
      const href = cfg.l1.explorerTx.replaceAll("{hash}", record.l1Hash);
      const link = el("a", { className: "hash", text: record.l1Hash });
      if (/^https:\/\//.test(href) && /^0x[0-9a-fA-F]{64}$/.test(record.l1Hash)) {
        link.href = href;
        link.rel = "noopener noreferrer";
      }
      line.append(link);
    } else {
      line.append(el("span", { className: "hash", text: record.l1Hash }));
    }
    depositResult.append(line);
    uncertain.hidden = true;
  }

  async function onConnect(): Promise<void> {
    if (!wallet) {
      guidance.hidden = false;
      guidance.textContent = GUIDANCE;
      setStatus(GUIDANCE);
      return;
    }
    try {
      const accounts = await wallet.connect();
      await applyAccounts(accounts);
      await readChain();
      await runVerify();
      renderAll();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not connect.");
    }
  }

  async function applyAccounts(accounts: string[]): Promise<void> {
    const first = accounts.find((item) => typeof item === "string");
    if (!first) {
      account = null;
      closeJournal();
      setText("account", "Not connected");
      renderProgress();
      renderHistory();
      return;
    }
    try {
      account = validateRecipient(first);
    } catch {
      account = null;
      setStatus("The wallet returned an unusable account.");
      return;
    }
    if (!recipientTouched) recipientInput.value = account;
    if (clientsReady()) openJournal(account);
    void refreshSepoliaBalance();
    void refreshForteBalance();
  }

  async function onReview(): Promise<void> {
    if (reviewing || submitting || !canReview()) return;
    if (!wallet || !cfg || !provider || !replica || !sequencer || !account) return;
    reviewing = true;
    syncButtons();
    try {
      const switched = await wallet.ensureSepolia({ l1: { rpc: cfg.l1.rpc } });
      if (!switched.ok) {
        if (switched.state === "user-rejected") setStatus("The network switch was rejected.");
        else if (switched.state === "request-pending") setStatus("A wallet request is already pending.");
        else setStatus("Could not switch to Sepolia.");
        return;
      }
      await readChain();
      const recipient = validateRecipient(recipientInput.value.trim());
      const built = await createQuote(
        { amount: amountInput.value.trim(), recipient, account },
        { cfg, replica, sequencer, wallet: provider, now },
      );
      const ctx = liveCtx();
      if (!ctx || !isQuoteValid(built, ctx, now())) {
        dropQuote();
        setStatus("The quote did not match the current wallet and form.");
        return;
      }
      quote = built;
      uncertain.hidden = true;
      renderReview(built);
      setStatus("Review the deposit, then approve in MetaMask.");
    } catch (err) {
      dropQuote();
      setStatus(err instanceof Error ? err.message : "Could not review the deposit.");
    } finally {
      reviewing = false;
      if (quote && !quoteStillValid()) dropQuote();
      syncButtons();
    }
  }

  async function onApprove(): Promise<void> {
    if (submitting) return;
    const current = quote;
    const ctx = liveCtx();
    if (!current || !ctx || !cfg || !provider || !l1 || !sequencer || !replica || !journal || !poller) return;
    if (!isQuoteValid(current, ctx, now()) || configState !== "ok") {
      dropQuote();
      syncButtons();
      return;
    }
    submitting = true;
    approveButton.disabled = true;
    reviewButton.disabled = true;
    const boundJournal = journal;
    const boundPoller = poller;
    setStatus("Awaiting your wallet approval");
    try {
      const result = await submitDeposit(current, {
        provider,
        cfg,
        l1,
        sequencer,
        replica,
        now,
        ctx,
        onHash(record) {
          const stored: DepositRecord = {
            ...record,
            reviewedAt: current.createdAt,
            approvedAt: now(),
          };
          boundJournal.upsert(stored);
          boundPoller.watch(stored);
          showSubmitted(stored);
          renderProgress();
          renderHistory();
        },
      });
      if (result.kind === "submitted") {
        dropQuote();
        showSubmitted(result.record);
        setStatus("Submitted. The Sepolia hash is below.");
      } else if (result.kind === "wallet-rejected") {
        dropQuote();
        setStatus("The wallet rejected the deposit. Review it again to continue.");
      } else if (result.kind === "blocked") {
        dropQuote();
        setStatus(result.reason);
      } else {
        dropQuote();
        uncertain.hidden = false;
        setStatus(result.guidance);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "The deposit could not be submitted.");
    } finally {
      submitting = false;
      syncButtons();
    }
  }

  async function recoverHash(raw: string): Promise<void> {
    if (!tracker || !journal || !poller) {
      historyStatus.textContent = "Connect a wallet before recovering a deposit.";
      return;
    }
    const hash = raw.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      historyStatus.textContent = "Enter a full L1 transaction hash.";
      return;
    }
    try {
      const record = await tracker.recover(hash);
      if (account === null || record.account.toLowerCase() !== account.toLowerCase()) {
        historyStatus.textContent = "That deposit was sent by a different account.";
        return;
      }
      proven.set(record.l1Hash.toLowerCase(), record);
      journal.upsert(record);
      poller.watch(record);
      historyStatus.textContent = `Recovered ${record.l1Hash}.`;
      renderProgress();
      renderHistory();
    } catch (err) {
      historyStatus.textContent = err instanceof Error ? err.message : "Could not recover that hash.";
    }
  }

  connectButton.addEventListener("click", () => {
    void onConnect();
  });
  reviewButton.addEventListener("click", () => {
    void onReview();
  });
  approveButton.addEventListener("click", () => {
    void onApprove();
  });
  amountInput.addEventListener("input", () => {
    showFieldErrors();
    invalidateReview("The amount changed. Review the deposit again.");
  });
  recipientInput.addEventListener("input", () => {
    recipientTouched = true;
    showFieldErrors();
    invalidateReview("The recipient changed. Review the deposit again.");
    void refreshForteBalance();
  });
  requireElement<HTMLButtonElement>("paste-recover").addEventListener("click", () => {
    void recoverHash(pasteHash.value);
  });
  requireElement<HTMLButtonElement>("recover").addEventListener("click", () => {
    void recoverHash(requireElement<HTMLInputElement>("recover-hash").value);
  });
  requireElement<HTMLButtonElement>("export-json").addEventListener("click", () => {
    if (!journal) {
      historyStatus.textContent = "Connect a wallet before exporting history.";
      return;
    }
    const blob = new Blob([journal.exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = el("a", { text: "fortel2-bridge-history.json" });
    link.href = url;
    link.download = "fortel2-bridge-history.json";
    historyList.append(link);
    link.click();
  });
  requireElement<HTMLInputElement>("import-file").addEventListener("change", () => {
    const input = requireElement<HTMLInputElement>("import-file");
    const file = input.files?.[0];
    if (!file || !journal || !poller) {
      importResult.textContent = "Connect a wallet before importing history.";
      return;
    }
    void file.text().then((text) => {
      const result = journal?.importJson(text);
      if (!result || !journal || !poller) return;
      importResult.textContent = `Accepted ${result.accepted}, refused ${result.refused}.`;
      for (const record of journal.list()) poller.watch(record);
      renderProgress();
      renderHistory();
    });
  });
  requireElement<HTMLButtonElement>("clear-history").addEventListener("click", () => {
    clearConfirm.hidden = false;
  });
  requireElement<HTMLButtonElement>("clear-no").addEventListener("click", () => {
    clearConfirm.hidden = true;
  });
  requireElement<HTMLButtonElement>("clear-yes").addEventListener("click", () => {
    if (journal && poller) {
      for (const record of journal.list()) poller.unwatch(record.l1Hash);
      journal.clear();
    }
    proven.clear();
    clearConfirm.hidden = true;
    historyStatus.textContent = "History cleared on this browser.";
    renderProgress();
    renderHistory();
  });
  requireElement<HTMLButtonElement>("link-replacement").addEventListener("click", () => {
    void linkReplacement();
  });

  async function linkReplacement(): Promise<void> {
    if (!tracker || !journal || !poller) {
      historyStatus.textContent = "Connect a wallet before linking a replacement.";
      return;
    }
    const originalHash = requireElement<HTMLInputElement>("replace-original").value.trim();
    const newHash = requireElement<HTMLInputElement>("replace-new").value.trim();
    const original = journal.list().find((record) => record.l1Hash.toLowerCase() === originalHash.toLowerCase());
    if (!original) {
      historyStatus.textContent = "That deposit is not in this history.";
      return;
    }
    const result = await tracker.linkReplacement(original, newHash);
    if (result.status === "rejected") {
      historyStatus.textContent = result.reason;
      return;
    }
    if (result.status === "unavailable") {
      proven.set(result.original.l1Hash.toLowerCase(), result.original);
      journal.upsert(result.original);
      historyStatus.textContent = "Replacement check unavailable.";
    } else if (result.status === "cancelled") {
      proven.set(result.original.l1Hash.toLowerCase(), result.original);
      journal.upsert(result.original);
      poller.watch(result.original);
      historyStatus.textContent = "The replacement cancelled this deposit.";
    } else {
      proven.set(result.original.l1Hash.toLowerCase(), result.original);
      proven.set(result.replacement.l1Hash.toLowerCase(), result.replacement);
      journal.upsert(result.original);
      journal.upsert(result.replacement);
      poller.watch(result.original);
      poller.watch(result.replacement);
      historyStatus.textContent = "Linked the replacement.";
    }
    renderProgress();
    renderHistory();
  }

  every(1000, tick);

  const found = await discoverMetaMask({
    ...(options.target ? { target: options.target } : {}),
    ...(options.timer ? { timer: options.timer } : {}),
    ...(options.windowMs !== undefined ? { windowMs: options.windowMs } : {}),
  });

  if (!found) {
    guidance.hidden = false;
    guidance.textContent = GUIDANCE;
    setStatus(GUIDANCE);
  } else {
    provider = found;
    wallet = createWallet(found);
    wallet.on("accountsChanged", (next) => {
      dropQuote();
      const list = Array.isArray(next) ? next.filter((item): item is string => typeof item === "string") : [];
      void applyAccounts(list).then(() => {
        setStatus("The wallet account changed. Review the deposit again.");
        void runVerify();
      });
    });
    wallet.on("chainChanged", (next) => {
      dropQuote();
      chainId = typeof next === "string" ? next : null;
      setStatus("The wallet network changed. Review the deposit again.");
      void readChain().then(() => runVerify());
    });
    wallet.on("disconnect", () => {
      dropQuote();
      account = null;
      closeJournal();
      setStatus("Wallet disconnected.");
      renderAll();
    });
    try {
      const existing = await wallet.reconnect();
      await applyAccounts(existing);
    } catch {
      setStatus("Could not read the connected account.");
    }
    await readChain();
  }

  const loaded = await loadConfig((url) => fetch(url));
  if (!loaded.ok) {
    if ("unavailable" in loaded) {
      configState = "unavailable";
      configStatus.textContent = "network check unavailable";
    } else {
      configState = "mismatch";
      configStatus.textContent = loaded.reason;
    }
    setStatus(configStatus.textContent);
    syncButtons();
    return { tick };
  }

  cfg = loaded.config;
  amountInput.value = formatEth(BigInt(cfg.deposit.defaultWei));
  clear(presets);
  for (const wei of cfg.deposit.presetsWei) {
    const button = el("button", { text: formatEth(BigInt(wei)) });
    button.type = "button";
    button.addEventListener("click", () => {
      amountInput.value = formatEth(BigInt(wei));
      amountInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    presets.append(button);
  }
  l1 = createRpcClient({ url: cfg.l1.rpc, allowedMethods: L1_READ, timeoutMs: RPC_TIMEOUT_MS });
  sequencer = createRpcClient({ url: cfg.l2.sequencerRpc, allowedMethods: L2_READ, timeoutMs: RPC_TIMEOUT_MS });
  replica = createRpcClient({ url: cfg.l2.replicaRpc, allowedMethods: L2_READ, timeoutMs: RPC_TIMEOUT_MS });

  if (provider) await runVerify();
  else {
    configState = "unavailable";
    configStatus.textContent = "Connect MetaMask to run the network check.";
  }
  if (account) openJournal(account);
  void refreshSepoliaBalance();
  void refreshForteBalance();
  renderAll();

  return {
    tick,
  };
}

function defaultEvery(ms: number, fn: () => void): () => void {
  const handle = setInterval(fn, ms);
  return () => clearInterval(handle);
}

function parseQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("balance is unreadable");
  }
  return BigInt(value);
}
