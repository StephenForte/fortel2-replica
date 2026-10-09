/**
 * Deposit tracker. Every refresh recomputes the phase from chain reads.
 * A stored phase is only a hint. A balance change is not evidence.
 */

import { id } from "ethers";

import {
  ProtocolError,
  decodeDepositEvent,
  deriveDeposit,
  matchDelegationWrapper,
  matchDirectPortalCall,
  type MatchedDeposit,
  type RpcLog,
  type RpcTransaction,
} from "./bridge-protocol";
import { RpcError, RpcUnavailableError, type RpcClient } from "./rpc";
import type { BridgeConfig, DecodedDeposit, DepositRecord, Phase } from "./types";

const DEPOSIT_TOPIC = id("TransactionDeposited(address,address,uint256,bytes)");
const NATIVE_L2_GAS = 100_000n;
const MAX_POLL_MS = 120_000;

/** Polling stops on these phases. `tracking-unavailable` stays active. */
export const TERMINAL_PHASES: readonly Phase[] = [
  "replica-confirmed",
  "l1-reverted",
  "l2-execution-failed",
  "unsupported-deposit",
  "replaced",
  "cancelled",
];

const TERMINAL = new Set<Phase>(TERMINAL_PHASES);

export type Tracker = {
  refresh(record: DepositRecord): Promise<DepositRecord>;
  recover(l1Hash: string): Promise<DepositRecord>;
  linkReplacement(original: DepositRecord, newHash: string): Promise<ReplacementResult>;
};

export type ReplacementResult =
  | { status: "rejected"; reason: string }
  | { status: "unavailable"; original: DepositRecord }
  | { status: "replaced"; original: DepositRecord; replacement: DepositRecord }
  | { status: "cancelled"; original: DepositRecord };

export type PollerVisibility = {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

export type PollerTimer = {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type Poller = {
  watch(record: DepositRecord): void;
  unwatch(l1Hash: string): void;
  records(): DepositRecord[];
  start(): void;
  stop(): void;
  dueAt(): number | null;
};

class NotProgress extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotProgress";
  }
}

type ChainRecord = Record<string, unknown>;

type LayerRead =
  | { kind: "missing" }
  | { kind: "pending" }
  | { kind: "uncanonical" }
  | { kind: "mismatch"; reason: string }
  | { kind: "failed" }
  | { kind: "success"; blockHash: string; blockNumber: string };

export function createTracker(options: {
  cfg: BridgeConfig;
  l1: RpcClient;
  sequencer: RpcClient;
  replica: RpcClient;
  now: () => number;
}): Tracker {
  const { cfg, l1, sequencer, replica, now } = options;

  function touch(record: DepositRecord, prior: DepositRecord, phase: Phase): DepositRecord {
    const next: DepositRecord = { ...record, phase, lastCheckedAt: now(), lastProvenPhase: phase };
    const l1Proven =
      phase === "l1-included" ||
      phase === "l2-pending" ||
      phase === "l2-received" ||
      phase === "replica-confirmed" ||
      phase === "l2-execution-failed";
    const l2Proven = phase === "l2-received" || phase === "replica-confirmed" || phase === "l2-execution-failed";
    assignStamp(next, "l1IncludedObservedAt", l1Proven ? (prior.l1IncludedObservedAt ?? now()) : undefined);
    assignStamp(next, "l2ObservedAt", l2Proven ? (prior.l2ObservedAt ?? now()) : undefined);
    assignStamp(next, "replicaObservedAt", replicaProven(phase) ? (prior.replicaObservedAt ?? now()) : undefined);
    if (phase !== "l1-reverted" && phase !== "l2-execution-failed" && phase !== "unsupported-deposit" && phase !== "cancelled") {
      delete next.lastError;
    }
    return next;
  }

  function unsupported(record: DepositRecord, prior: DepositRecord, reason: string, l1Accepted: boolean): DepositRecord {
    const next = touch(record, prior, "unsupported-deposit");
    next.lastError = reason;
    if (l1Accepted) next.l1IncludedObservedAt = prior.l1IncludedObservedAt ?? now();
    return next;
  }

  function markUnavailable(latest: DepositRecord, prior: DepositRecord, reason: string): DepositRecord {
    const next: DepositRecord = {
      ...latest,
      phase: "tracking-unavailable",
      lastError: reason.length > 0 ? reason : "unavailable",
      lastCheckedAt: now(),
    };
    const proven = prior.phase === "tracking-unavailable" ? prior.lastProvenPhase : prior.phase;
    if (proven === undefined) delete next.lastProvenPhase;
    else next.lastProvenPhase = proven;
    return next;
  }

  async function refresh(record: DepositRecord): Promise<DepositRecord> {
    let latest: DepositRecord = { ...record };
    try {
      return await derive(record, (next) => {
        latest = next;
      });
    } catch (err) {
      if (isPause(err)) return markUnavailable(latest, record, err.message);
      throw err;
    }
  }

  async function derive(prior: DepositRecord, publish: (next: DepositRecord) => void): Promise<DepositRecord> {
    if (!sameChain(prior, cfg)) return unsupported(shell(prior), prior, "record chain mismatch", false);

    const txRaw = await l1.call("eth_getTransactionByHash", [prior.l1Hash]);
    const receiptRaw = await l1.call("eth_getTransactionReceipt", [prior.l1Hash]);
    if (txRaw === null && receiptRaw === null) return pending(prior, prior.nonce);
    if (!isChainRecord(txRaw)) throw new NotProgress("l1 transaction malformed");
    if (receiptRaw !== null && !isChainRecord(receiptRaw)) throw new NotProgress("l1 receipt malformed");

    const txHash = hashOf(txRaw.hash);
    if (txHash === null || !sameText(txHash, prior.l1Hash)) throw new NotProgress("l1 tx hash mismatch");
    const from = addressOf(txRaw.from);
    if (from === null) throw new NotProgress("l1 from malformed");
    if (!sameText(from, prior.account)) return unsupported(shell(prior), prior, "l1 from mismatch", false);
    const nonce = nonceOf(txRaw.nonce);
    if (nonce === null) throw new NotProgress("l1 nonce malformed");
    if (receiptRaw === null) return pending(prior, nonce);

    const receiptTx = hashOf(receiptRaw.transactionHash);
    if (receiptTx !== null && !sameText(receiptTx, txHash)) throw new NotProgress("l1 receipt hash mismatch");
    const blockNumber = quantityHex(receiptRaw.blockNumber);
    const blockHash = hashOf(receiptRaw.blockHash);
    if (blockNumber === null || blockHash === null) throw new NotProgress("l1 receipt block malformed");
    if (!(await canonical(l1, blockNumber, blockHash))) return pending(prior, nonce);

    const status = statusOf(receiptRaw.status);
    if (status === null) throw new NotProgress("l1 receipt status malformed");
    const fee = feeOf(receiptRaw);
    if (fee === null) throw new NotProgress("l1 fee malformed");

    if (status === 0) {
      const reverted = shell(prior);
      reverted.nonce = nonce;
      reverted.l1BlockHash = blockHash;
      reverted.l1BlockNumber = Number(BigInt(blockNumber));
      reverted.actualL1FeeWei = fee.actualL1FeeWei;
      reverted.l1GasUsed = fee.l1GasUsed;
      reverted.effectiveGasPriceWei = fee.effectiveGasPriceWei;
      reverted.lastError = "l1 reverted";
      return touch(reverted, prior, "l1-reverted");
    }

    const matched = matchDirectPortalCall(asRpcTransaction(txRaw), cfg) ?? matchDelegationWrapper(asRpcTransaction(txRaw), cfg);
    const base = shell(prior);
    base.nonce = nonce;
    if (matched === null) return unsupported(base, prior, "not a native deposit", false);

    const logs = portalDepositLogs(receiptRaw.logs, cfg.contracts.optimismPortal);
    if (logs === "malformed") throw new NotProgress("l1 logs malformed");
    if (logs.length !== 1) return unsupported(base, prior, "expected one TransactionDeposited log", false);
    if (logs[0].removed) return unsupported(base, prior, "deposit log removed", false);
    const rpcLog = asRpcLog(logs[0].log);
    if (rpcLog === null) throw new NotProgress("l1 log malformed");
    if (!sameText(rpcLog.blockHash, blockHash)) return unsupported(base, prior, "deposit log block mismatch", false);

    let decoded: DecodedDeposit;
    try {
      decoded = decodeDepositEvent(rpcLog, cfg.contracts.optimismPortal);
    } catch (err) {
      const reason = err instanceof ProtocolError ? err.message : "deposit log undecodable";
      return unsupported(base, prior, reason, false);
    }
    const rejection = rejectDeposit(decoded, matched, prior, cfg);
    if (rejection !== null) return unsupported(base, prior, rejection, false);

    let derived: { sourceHash: string; l2Hash: string };
    try {
      derived = deriveDeposit(decoded);
    } catch (err) {
      const reason = err instanceof ProtocolError ? err.message : "derive failed";
      return unsupported(base, prior, reason, false);
    }

    const included = shell(prior);
    included.nonce = nonce;
    included.l1BlockHash = blockHash;
    included.l1BlockNumber = Number(BigInt(blockNumber));
    included.depositLogIndex = decoded.logIndex;
    included.sourceHash = derived.sourceHash;
    included.l2Hash = derived.l2Hash;
    included.actualL1FeeWei = fee.actualL1FeeWei;
    included.l1GasUsed = fee.l1GasUsed;
    included.effectiveGasPriceWei = fee.effectiveGasPriceWei;
    included.phase = "l1-included";
    included.lastCheckedAt = now();
    included.lastProvenPhase = "l1-included";
    included.l1IncludedObservedAt = prior.l1IncludedObservedAt ?? now();
    if (prior.l2ObservedAt !== undefined) included.l2ObservedAt = prior.l2ObservedAt;
    if (prior.replicaObservedAt !== undefined) included.replicaObservedAt = prior.replicaObservedAt;
    publish(included);

    const l2 = await readLayer(sequencer, derived.l2Hash, decoded, derived.sourceHash);
    if (l2.kind === "missing" || l2.kind === "pending" || l2.kind === "uncanonical") {
      return touch(included, prior, "l2-pending");
    }
    if (l2.kind === "mismatch") return unsupported(included, prior, l2.reason, true);
    if (l2.kind === "failed") {
      const failed = touch(included, prior, "l2-execution-failed");
      failed.lastError = `l2 execution failed from ${decoded.from}`;
      publish(failed);
      return failed;
    }

    const received = touch(included, prior, "l2-received");
    if (prior.replicaObservedAt !== undefined) received.replicaObservedAt = prior.replicaObservedAt;
    publish(received);

    const seen = await readLayer(replica, derived.l2Hash, decoded, derived.sourceHash);
    if (seen.kind === "mismatch") return unsupported(received, prior, seen.reason, true);
    if (seen.kind !== "success" || !sameText(seen.blockHash, l2.blockHash)) {
      return touch(included, prior, "l2-received");
    }
    if (!(await canonical(replica, seen.blockNumber, seen.blockHash))) {
      return touch(included, prior, "l2-received");
    }
    return touch(included, prior, "replica-confirmed");
  }

  function pending(prior: DepositRecord, nonce: number | undefined): DepositRecord {
    const next = shell(prior);
    if (nonce !== undefined) next.nonce = nonce;
    return touch(next, prior, "l1-pending");
  }

  async function recover(l1Hash: string): Promise<DepositRecord> {
    const txRaw = await l1.call("eth_getTransactionByHash", [l1Hash]);
    if (!isChainRecord(txRaw)) throw new ProtocolError("recover: transaction not found");
    const txHash = hashOf(txRaw.hash);
    const from = addressOf(txRaw.from);
    if (txHash === null || from === null || !sameText(txHash, l1Hash)) {
      throw new ProtocolError("recover: transaction not found");
    }
    const matched = matchDirectPortalCall(asRpcTransaction(txRaw), cfg) ?? matchDelegationWrapper(asRpcTransaction(txRaw), cfg);
    const nonce = nonceOf(txRaw.nonce);
    const record: DepositRecord = {
      schemaVersion: 1,
      account: from,
      recipient: matched?.recipient ?? from,
      amountWei: matched === null ? "0" : matched.amountWei.toString(10),
      configVersion: cfg.configVersion,
      l1ChainId: cfg.l1.chainId,
      l2ChainId: cfg.l2.chainId,
      l2GenesisHash: cfg.l2.genesisHash,
      l1Hash: txHash,
      phase: "l1-pending",
    };
    if (nonce !== null) record.nonce = nonce;
    if (matched === null) {
      record.phase = "unsupported-deposit";
      record.lastError = "not a native deposit";
      record.lastCheckedAt = now();
      record.lastProvenPhase = "unsupported-deposit";
      return record;
    }
    return refresh(record);
  }

  async function linkReplacement(original: DepositRecord, newHash: string): Promise<ReplacementResult> {
    if (sameText(original.l1Hash, newHash)) return { status: "rejected", reason: "same hash" };
    let txRaw: unknown;
    try {
      txRaw = await l1.call("eth_getTransactionByHash", [newHash]);
    } catch (err) {
      if (!isPause(err)) throw err;
      return { status: "unavailable", original: markUnavailable({ ...original }, original, err.message) };
    }
    if (!isChainRecord(txRaw)) return { status: "rejected", reason: "transaction not found" };
    const txHash = hashOf(txRaw.hash);
    const from = addressOf(txRaw.from);
    const nonce = nonceOf(txRaw.nonce);
    if (txHash === null || from === null || nonce === null || !sameText(txHash, newHash)) {
      return { status: "rejected", reason: "transaction not found" };
    }
    if (!sameText(from, original.account)) return { status: "rejected", reason: "from mismatch" };
    if (original.nonce === undefined || nonce !== original.nonce) return { status: "rejected", reason: "nonce mismatch" };

    const matched = matchDirectPortalCall(asRpcTransaction(txRaw), cfg) ?? matchDelegationWrapper(asRpcTransaction(txRaw), cfg);
    const sameIntent =
      matched !== null && sameText(matched.recipient, original.recipient) && decimalEquals(original.amountWei, matched.amountWei);
    if (!sameIntent || matched === null) {
      const cancelled = shell(original);
      cancelled.nonce = original.nonce;
      const done = touch(cancelled, original, "cancelled");
      done.lastError = "replacement is not the same deposit";
      return { status: "cancelled", original: done };
    }

    const replaced = shell(original);
    replaced.nonce = original.nonce;
    replaced.replacedBy = txHash;
    const originalDone = touch(replaced, original, "replaced");
    const seed: DepositRecord = {
      schemaVersion: 1,
      account: from,
      recipient: matched.recipient,
      amountWei: matched.amountWei.toString(10),
      configVersion: cfg.configVersion,
      l1ChainId: cfg.l1.chainId,
      l2ChainId: cfg.l2.chainId,
      l2GenesisHash: cfg.l2.genesisHash,
      l1Hash: txHash,
      replaces: original.l1Hash,
      nonce,
      phase: "l1-pending",
    };
    return { status: "replaced", original: originalDone, replacement: await refresh(seed) };
  }

  return { refresh, recover, linkReplacement };
}

export function createPoller(options: {
  tracker: { refresh(record: DepositRecord): Promise<DepositRecord> };
  intervalMs: number;
  visibility?: PollerVisibility;
  now?: () => number;
  timer?: PollerTimer;
  onUpdate?: (record: DepositRecord) => void;
}): Poller {
  const readNow = options.now ?? (() => Date.now());
  const timer: PollerTimer = options.timer ?? {
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const base = Math.min(Math.max(options.intervalMs, 0), MAX_POLL_MS);
  let delay = base;
  let handle: unknown = null;
  let due: number | null = null;
  let started = false;
  let inFlight = false;
  const watched = new Map<string, DepositRecord>();

  const hidden = () => options.visibility?.visibilityState === "hidden";
  const hasActive = () => [...watched.values()].some((record) => !TERMINAL.has(record.phase));

  function clearArmed(): void {
    if (handle !== null) timer.clearTimeout(handle);
    handle = null;
    due = null;
  }

  function arm(ms: number): void {
    clearArmed();
    if (!started || hidden() || !hasActive()) return;
    const capped = Math.min(Math.max(ms, 0), MAX_POLL_MS);
    due = readNow() + capped;
    const wait = Math.max(0, due - readNow());
    handle = timer.setTimeout(() => {
      handle = null;
      void run();
    }, wait);
  }

  async function run(): Promise<void> {
    if (inFlight || !started || hidden() || !hasActive()) return;
    inFlight = true;
    arm(delay);
    let sawUnavailable = false;
    try {
      for (const [key, record] of [...watched.entries()]) {
        if (!started || hidden()) break;
        if (TERMINAL.has(record.phase)) continue;
        const next = await options.tracker.refresh(record);
        watched.set(key, next);
        options.onUpdate?.(next);
        if (next.phase === "tracking-unavailable") sawUnavailable = true;
      }
    } finally {
      delay = sawUnavailable ? Math.min(delay * 2, MAX_POLL_MS) : base;
      inFlight = false;
      if (started && !hidden() && hasActive()) arm(delay);
      else clearArmed();
    }
  }

  function onVisibility(): void {
    if (!started) return;
    if (hidden()) {
      clearArmed();
      return;
    }
    if (!inFlight) void run();
  }

  return {
    watch(record) {
      watched.set(record.l1Hash.toLowerCase(), { ...record });
      if (started && !hidden() && !inFlight) void run();
    },
    unwatch(l1Hash) {
      watched.delete(l1Hash.toLowerCase());
    },
    records() {
      return [...watched.values()].map((record) => ({ ...record }));
    },
    start() {
      if (started) {
        void run();
        return;
      }
      started = true;
      options.visibility?.addEventListener("visibilitychange", onVisibility);
      if (!hidden()) void run();
    },
    stop() {
      started = false;
      clearArmed();
      options.visibility?.removeEventListener("visibilitychange", onVisibility);
    },
    dueAt() {
      return due;
    },
  };
}

function replicaProven(phase: Phase): boolean {
  return phase === "replica-confirmed";
}

function shell(record: DepositRecord): DepositRecord {
  const next: DepositRecord = {
    schemaVersion: 1,
    account: record.account,
    recipient: record.recipient,
    amountWei: record.amountWei,
    configVersion: record.configVersion,
    l1ChainId: record.l1ChainId,
    l2ChainId: record.l2ChainId,
    l2GenesisHash: record.l2GenesisHash,
    l1Hash: record.l1Hash,
    phase: record.phase,
  };
  if (record.submittedAt !== undefined) next.submittedAt = record.submittedAt;
  if (record.reviewedAt !== undefined) next.reviewedAt = record.reviewedAt;
  if (record.approvedAt !== undefined) next.approvedAt = record.approvedAt;
  if (record.replaces !== undefined) next.replaces = record.replaces;
  if (record.replacedBy !== undefined) next.replacedBy = record.replacedBy;
  if (record.nonce !== undefined) next.nonce = record.nonce;
  return next;
}

function sameChain(record: DepositRecord, cfg: BridgeConfig): boolean {
  return (
    record.schemaVersion === 1 &&
    record.l1ChainId === cfg.l1.chainId &&
    record.l2ChainId === cfg.l2.chainId &&
    sameText(record.l2GenesisHash, cfg.l2.genesisHash)
  );
}

function rejectDeposit(event: DecodedDeposit, matched: MatchedDeposit, record: DepositRecord, cfg: BridgeConfig): string | null {
  if (event.isCreation) return "isCreation";
  if (event.gas !== NATIVE_L2_GAS || matched.l2GasLimit !== NATIVE_L2_GAS) return "gas mismatch";
  if (!sameText(event.to, matched.recipient)) return "recipient mismatch";
  if (event.mint !== event.value || event.value !== matched.amountWei) return "amount mismatch";
  let cap: bigint;
  try {
    cap = BigInt(cfg.deposit.capWei);
  } catch {
    return "cap malformed";
  }
  if (matched.amountWei > cap) return "amount above cap";
  if (!sameText(record.recipient, matched.recipient)) return "intent recipient mismatch";
  if (!decimalEquals(record.amountWei, matched.amountWei)) return "intent amount mismatch";
  return null;
}

async function readLayer(client: RpcClient, l2Hash: string, event: DecodedDeposit, sourceHash: string): Promise<LayerRead> {
  const txRaw = await client.call("eth_getTransactionByHash", [l2Hash]);
  if (txRaw === null) return { kind: "missing" };
  if (!isChainRecord(txRaw)) throw new NotProgress("l2 transaction malformed");
  const txHash = hashOf(txRaw.hash);
  if (txHash !== null && !sameText(txHash, l2Hash)) throw new NotProgress("l2 tx hash mismatch");
  const reason = depositTxMismatch(txRaw, event, sourceHash);
  if (reason !== null) return { kind: "mismatch", reason };
  const receiptRaw = await client.call("eth_getTransactionReceipt", [l2Hash]);
  if (receiptRaw === null) return { kind: "pending" };
  if (!isChainRecord(receiptRaw)) throw new NotProgress("l2 receipt malformed");
  const receiptTx = hashOf(receiptRaw.transactionHash);
  if (receiptTx !== null && !sameText(receiptTx, l2Hash)) throw new NotProgress("l2 receipt hash mismatch");
  const blockNumber = quantityHex(receiptRaw.blockNumber);
  const blockHash = hashOf(receiptRaw.blockHash);
  if (blockNumber === null || blockHash === null) throw new NotProgress("l2 receipt block malformed");
  const status = statusOf(receiptRaw.status);
  if (status === null) throw new NotProgress("l2 receipt status malformed");
  if (!(await canonical(client, blockNumber, blockHash))) return { kind: "uncanonical" };
  if (status === 0) return { kind: "failed" };
  return { kind: "success", blockHash, blockNumber };
}

async function canonical(client: RpcClient, blockNumber: string, blockHash: string): Promise<boolean> {
  const block = await client.call("eth_getBlockByNumber", [blockNumber, false]);
  if (block === null) return false;
  if (!isChainRecord(block)) throw new NotProgress("block malformed");
  const hash = hashOf(block.hash);
  if (hash === null) throw new NotProgress("block hash malformed");
  return sameText(hash, blockHash);
}

function depositTxMismatch(tx: ChainRecord, event: DecodedDeposit, sourceHash: string): string | null {
  if (typeof tx.type !== "string" || tx.type.toLowerCase() !== "0x7e") return "l2 type mismatch";
  if (typeof tx.sourceHash !== "string" || !sameText(tx.sourceHash, sourceHash)) return "l2 sourceHash mismatch";
  const from = addressOf(tx.from);
  const to = addressOf(tx.to);
  if (from === null || !sameText(from, event.from)) return "l2 from mismatch";
  if (to === null || !sameText(to, event.to)) return "l2 to mismatch";
  const mint = quantityOf(tx.mint);
  const value = quantityOf(tx.value);
  const gas = quantityOf(tx.gas);
  if (mint === null || mint !== event.mint) return "l2 mint mismatch";
  if (value === null || value !== event.value) return "l2 value mismatch";
  if (gas === null || gas !== event.gas) return "l2 gas mismatch";
  const input = tx.input ?? tx.data;
  if (typeof input !== "string" || input.toLowerCase() !== "0x") return "l2 input mismatch";
  if (tx.isSystemTx === true) return "l2 isSystemTx";
  if (tx.isSystemTx !== undefined && tx.isSystemTx !== null && tx.isSystemTx !== false) return "l2 isSystemTx";
  return null;
}

function portalDepositLogs(
  logs: unknown,
  portal: string,
): { log: ChainRecord; removed: boolean }[] | "malformed" {
  if (!Array.isArray(logs)) return "malformed";
  const found: { log: ChainRecord; removed: boolean }[] = [];
  for (const log of logs) {
    if (!isChainRecord(log)) return "malformed";
    if (typeof log.address !== "string" || !Array.isArray(log.topics)) return "malformed";
    const topic0 = log.topics[0];
    if (typeof topic0 !== "string") continue;
    if (!sameText(log.address, portal) || !sameText(topic0, DEPOSIT_TOPIC)) continue;
    found.push({ log, removed: log.removed === true });
  }
  return found;
}

function asRpcLog(log: ChainRecord): RpcLog | null {
  if (typeof log.address !== "string" || typeof log.data !== "string") return null;
  if (typeof log.logIndex !== "string" || typeof log.blockHash !== "string") return null;
  if (!Array.isArray(log.topics) || !log.topics.every((topic) => typeof topic === "string")) return null;
  return { address: log.address, topics: log.topics, data: log.data, logIndex: log.logIndex, blockHash: log.blockHash };
}

function asRpcTransaction(tx: ChainRecord): RpcTransaction {
  const input = tx.input ?? tx.data;
  return {
    to: typeof tx.to === "string" ? tx.to : null,
    value: typeof tx.value === "string" ? tx.value : "0x0",
    ...(typeof input === "string" ? { input } : {}),
  };
}

function assignStamp(record: DepositRecord, key: "l1IncludedObservedAt" | "l2ObservedAt" | "replicaObservedAt", value: number | undefined): void {
  if (value === undefined) delete record[key];
  else record[key] = value;
}

function isPause(err: unknown): err is RpcUnavailableError | RpcError | NotProgress {
  return err instanceof RpcUnavailableError || err instanceof RpcError || err instanceof NotProgress;
}

function isChainRecord(value: unknown): value is ChainRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hashOf(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return value;
}

function addressOf(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return value;
}

function sameText(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function quantityHex(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  return value;
}

function quantityOf(value: unknown): bigint | null {
  const hex = quantityHex(value);
  if (hex === null) return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

function nonceOf(value: unknown): number | null {
  const nonce = quantityOf(value);
  if (nonce === null || nonce > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(nonce);
}

function statusOf(value: unknown): 0 | 1 | null {
  const status = quantityOf(value);
  if (status === 0n) return 0;
  if (status === 1n) return 1;
  return null;
}

function feeOf(receipt: ChainRecord): { actualL1FeeWei: string; l1GasUsed: string; effectiveGasPriceWei: string } | null {
  const gasUsed = quantityOf(receipt.gasUsed);
  const price = quantityOf(receipt.effectiveGasPrice);
  if (gasUsed === null || price === null) return null;
  return {
    actualL1FeeWei: (gasUsed * price).toString(10),
    l1GasUsed: gasUsed.toString(10),
    effectiveGasPriceWei: price.toString(10),
  };
}

function decimalEquals(text: string, amount: bigint): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return false;
  try {
    return BigInt(text) === amount;
  } catch {
    return false;
  }
}
