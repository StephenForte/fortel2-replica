/**
 * Browser journal. A stored record is a hint. importJson drops chain-derived
 * fields and forces l1-pending so a pasted file cannot forge a success.
 */

import type { BridgeConfig, DepositRecord, Phase } from "./types";

const KEY_PREFIX = "fortel2-bridge:v1";

const PHASES = new Set<Phase>([
  "disconnected",
  "editing",
  "reviewing",
  "ready",
  "awaiting-wallet",
  "l1-pending",
  "l1-included",
  "l2-pending",
  "l2-received",
  "replica-confirmed",
  "wallet-rejected",
  "l1-reverted",
  "replaced",
  "cancelled",
  "configuration-mismatch",
  "unsupported-deposit",
  "l2-execution-failed",
  "tracking-unavailable",
]);

export type JournalStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type JournalImport = {
  accepted: number;
  refused: number;
};

export type Journal = {
  key: string;
  list(): DepositRecord[];
  upsert(record: DepositRecord): void;
  remove(l1Hash: string): void;
  clear(): void;
  exportJson(): string;
  importJson(json: string): JournalImport;
  totalActualFeesWei(): string;
};

type Envelope = {
  schemaVersion: 1;
  l1ChainId: number;
  l2ChainId: number;
  l2GenesisHash: string;
  account: string;
  records: unknown[];
};

export function createJournal(options: {
  storage?: JournalStorage | null;
  cfg: BridgeConfig;
  account: string;
}): Journal {
  const { cfg } = options;
  const account = options.account.toLowerCase();
  const key = `${KEY_PREFIX}:${cfg.l1.chainId}:${cfg.l2.chainId}:${cfg.l2.genesisHash}:${account}`;
  const storage = usable(options.storage);
  let memoryOnly = storage === null;
  let records: DepositRecord[] = [];

  load();

  function load(): void {
    if (memoryOnly || storage === null) return;
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      memoryOnly = true;
      records = [];
      return;
    }
    if (raw === null || raw === "") return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isEnvelope(parsed, cfg, account)) return;
      const loaded: DepositRecord[] = [];
      for (const item of parsed.records) {
        const record = readRecord(item, cfg, account, true);
        if (record !== null) loaded.push(canonical(record));
      }
      records = loaded;
    } catch {
      records = [];
    }
  }

  function save(): void {
    if (memoryOnly || storage === null) return;
    try {
      if (records.length === 0) storage.removeItem(key);
      else storage.setItem(key, exportJson());
    } catch {
      memoryOnly = true;
    }
  }

  function list(): DepositRecord[] {
    return records.map((record) => canonical(record));
  }

  function upsert(record: DepositRecord): void {
    const copy = canonical(record);
    const hash = copy.l1Hash.toLowerCase();
    const index = records.findIndex((item) => item.l1Hash.toLowerCase() === hash);
    if (index >= 0) records[index] = copy;
    else records.push(copy);
    save();
  }

  function remove(l1Hash: string): void {
    const hash = l1Hash.toLowerCase();
    records = records.filter((item) => item.l1Hash.toLowerCase() !== hash);
    save();
  }

  function clear(): void {
    records = [];
    save();
  }

  function exportJson(): string {
    return JSON.stringify({
      schemaVersion: 1,
      l1ChainId: cfg.l1.chainId,
      l2ChainId: cfg.l2.chainId,
      l2GenesisHash: cfg.l2.genesisHash,
      account,
      records: records.map((record) => canonical(record)),
    });
  }

  function importJson(json: string): JournalImport {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { accepted: 0, refused: 1 };
    }
    if (!isEnvelope(parsed, cfg, account)) {
      return { accepted: 0, refused: countRecords(parsed) };
    }
    let accepted = 0;
    let refused = 0;
    for (const item of parsed.records) {
      const record = readRecord(item, cfg, account, true);
      if (record === null) {
        refused += 1;
        continue;
      }
      upsert(stripProof(record));
      accepted += 1;
    }
    return { accepted, refused };
  }

  function totalActualFeesWei(): string {
    const seen = new Set<string>();
    let total = 0n;
    for (const record of records) {
      const hash = record.l1Hash.toLowerCase();
      if (seen.has(hash)) continue;
      seen.add(hash);
      if (record.actualL1FeeWei === undefined) continue;
      try {
        const fee = BigInt(record.actualL1FeeWei);
        if (fee >= 0n) total += fee;
      } catch {
        continue;
      }
    }
    return total.toString(10);
  }

  return { key, list, upsert, remove, clear, exportJson, importJson, totalActualFeesWei };
}

function usable(storage: JournalStorage | null | undefined): JournalStorage | null {
  if (storage === null || storage === undefined) return null;
  if (typeof storage.getItem !== "function" || typeof storage.setItem !== "function" || typeof storage.removeItem !== "function") {
    return null;
  }
  return storage;
}

function isEnvelope(value: unknown, cfg: BridgeConfig, account: string): value is Envelope {
  if (!isObj(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (value.l1ChainId !== cfg.l1.chainId || value.l2ChainId !== cfg.l2.chainId) return false;
  if (typeof value.l2GenesisHash !== "string" || value.l2GenesisHash.toLowerCase() !== cfg.l2.genesisHash.toLowerCase()) return false;
  if (typeof value.account !== "string" || value.account.toLowerCase() !== account) return false;
  return Array.isArray(value.records);
}

function countRecords(value: unknown): number {
  if (isObj(value) && Array.isArray(value.records)) return Math.max(value.records.length, 1);
  return 1;
}

function readRecord(value: unknown, cfg: BridgeConfig, account: string, checkAccount: boolean): DepositRecord | null {
  if (!isObj(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (typeof value.l1Hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.l1Hash)) return null;
  if (typeof value.account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.account)) return null;
  if (checkAccount && value.account.toLowerCase() !== account) return null;
  if (typeof value.recipient !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.recipient)) return null;
  if (typeof value.amountWei !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.amountWei)) return null;
  if (typeof value.configVersion !== "string" || value.configVersion.length === 0) return null;
  if (value.l1ChainId !== cfg.l1.chainId || value.l2ChainId !== cfg.l2.chainId) return null;
  if (typeof value.l2GenesisHash !== "string" || value.l2GenesisHash.toLowerCase() !== cfg.l2.genesisHash.toLowerCase()) {
    return null;
  }
  if (typeof value.phase !== "string" || !PHASES.has(value.phase as Phase)) return null;

  const record: DepositRecord = {
    schemaVersion: 1,
    account: value.account,
    recipient: value.recipient,
    amountWei: value.amountWei,
    configVersion: value.configVersion,
    l1ChainId: cfg.l1.chainId,
    l2ChainId: cfg.l2.chainId,
    l2GenesisHash: cfg.l2.genesisHash,
    l1Hash: value.l1Hash,
    phase: value.phase as Phase,
  };
  copyNumber(record, "submittedAt", value.submittedAt);
  copyNumber(record, "reviewedAt", value.reviewedAt);
  copyNumber(record, "approvedAt", value.approvedAt);
  copyNumber(record, "lastCheckedAt", value.lastCheckedAt);
  copyNumber(record, "l1IncludedObservedAt", value.l1IncludedObservedAt);
  copyNumber(record, "l2ObservedAt", value.l2ObservedAt);
  copyNumber(record, "replicaObservedAt", value.replicaObservedAt);
  copyNumber(record, "l1BlockNumber", value.l1BlockNumber);
  copyNumber(record, "depositLogIndex", value.depositLogIndex);
  copyNumber(record, "nonce", value.nonce);
  copyHash(record, "l1BlockHash", value.l1BlockHash);
  copyHash(record, "sourceHash", value.sourceHash);
  copyHash(record, "l2Hash", value.l2Hash);
  copyHash(record, "replacedBy", value.replacedBy);
  copyHash(record, "replaces", value.replaces);
  copyDecimal(record, "actualL1FeeWei", value.actualL1FeeWei);
  copyDecimal(record, "l1GasUsed", value.l1GasUsed);
  copyDecimal(record, "effectiveGasPriceWei", value.effectiveGasPriceWei);
  if (typeof value.lastError === "string") record.lastError = value.lastError;
  if (typeof value.lastProvenPhase === "string" && PHASES.has(value.lastProvenPhase as Phase)) {
    record.lastProvenPhase = value.lastProvenPhase as Phase;
  }
  return record;
}

/** Drop every chain-derived proof so the tracker has to earn the phase again. */
function stripProof(record: DepositRecord): DepositRecord {
  const next = canonical(record);
  next.phase = "l1-pending";
  delete next.l1BlockHash;
  delete next.l1BlockNumber;
  delete next.depositLogIndex;
  delete next.sourceHash;
  delete next.l2Hash;
  delete next.actualL1FeeWei;
  delete next.l1GasUsed;
  delete next.effectiveGasPriceWei;
  delete next.l1IncludedObservedAt;
  delete next.l2ObservedAt;
  delete next.replicaObservedAt;
  delete next.nonce;
  delete next.lastError;
  delete next.lastProvenPhase;
  return next;
}

function canonical(record: DepositRecord): DepositRecord {
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
  copyNumber(next, "submittedAt", record.submittedAt);
  copyNumber(next, "reviewedAt", record.reviewedAt);
  copyNumber(next, "approvedAt", record.approvedAt);
  copyHash(next, "replaces", record.replaces);
  copyHash(next, "replacedBy", record.replacedBy);
  copyNumber(next, "nonce", record.nonce);
  copyHash(next, "l1BlockHash", record.l1BlockHash);
  copyNumber(next, "l1BlockNumber", record.l1BlockNumber);
  copyNumber(next, "depositLogIndex", record.depositLogIndex);
  copyHash(next, "sourceHash", record.sourceHash);
  copyHash(next, "l2Hash", record.l2Hash);
  copyDecimal(next, "actualL1FeeWei", record.actualL1FeeWei);
  copyDecimal(next, "l1GasUsed", record.l1GasUsed);
  copyDecimal(next, "effectiveGasPriceWei", record.effectiveGasPriceWei);
  copyNumber(next, "l1IncludedObservedAt", record.l1IncludedObservedAt);
  copyNumber(next, "l2ObservedAt", record.l2ObservedAt);
  copyNumber(next, "replicaObservedAt", record.replicaObservedAt);
  copyNumber(next, "lastCheckedAt", record.lastCheckedAt);
  if (record.lastProvenPhase !== undefined) next.lastProvenPhase = record.lastProvenPhase;
  if (record.lastError !== undefined) next.lastError = record.lastError;
  return next;
}

function copyNumber<K extends "submittedAt" | "reviewedAt" | "approvedAt" | "lastCheckedAt" | "l1IncludedObservedAt" | "l2ObservedAt" | "replicaObservedAt" | "l1BlockNumber" | "depositLogIndex" | "nonce">(
  record: DepositRecord,
  key: K,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value)) record[key] = value as DepositRecord[K];
}

function copyHash<K extends "l1BlockHash" | "sourceHash" | "l2Hash" | "replacedBy" | "replaces">(
  record: DepositRecord,
  key: K,
  value: unknown,
): void {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) record[key] = value as DepositRecord[K];
}

function copyDecimal<K extends "actualL1FeeWei" | "l1GasUsed" | "effectiveGasPriceWei">(
  record: DepositRecord,
  key: K,
  value: unknown,
): void {
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) record[key] = value as DepositRecord[K];
}

function isObj(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
