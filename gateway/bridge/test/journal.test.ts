import { describe, expect, it } from "vitest";

import { createJournal, type JournalStorage } from "../src/journal";
import type { BridgeConfig, DepositRecord } from "../src/types";

const ACCOUNT = "0xb84982A02a96c88676df643b6ee6b691bcded019";
const HASH = "0x57b64e5ba293e42bbc6d3ce9d5eebf39b909eebff84973d1f71c1b35c45d8fa3";
const OTHER = "0x1111111111111111111111111111111111111111111111111111111111111111";
const FORGED_L2 = "0xabababababababababababababababababababababababababababababababab";

const cfg: BridgeConfig = {
  configVersion: "852-sepolia-2026-10-08.1",
  l1: {
    chainId: 11155111,
    chainIdHex: "0xaa36a7",
    name: "Sepolia",
    rpc: "https://sepolia.gateway.tenderly.co",
    explorerTx: "https://sepolia.etherscan.io/tx/{hash}",
  },
  l2: {
    chainId: 852,
    chainIdHex: "0x354",
    name: "ForteL2 Sepolia",
    genesisHash: "0xe242b1a3312b509e7df1496847f0bd0b115cb66676b1e973a355296c99e2386d",
    sequencerRpc: "https://fortel2-sequencer-rpc.onrender.com/",
    replicaRpc: "/",
    explorerTx: "https://settlementos-explorer-ihgo.onrender.com/fortel2-sepolia/tx/{hash}",
  },
  contracts: {
    optimismPortal: "0xf8c7da6c009d5d05bb98f8cd8286b9b838a3b54e",
    systemConfig: "0x7c799f23a427328831be0a8206a525a9bc886bde",
    metamaskDelegationManager: "0xdb9b1e94b5b69df7e401ddbede43491141047db3",
  },
  deposit: {
    l2GasLimit: "100000",
    capWei: "20000000000000000",
    presetsWei: ["1000000000000000", "2000000000000000", "5000000000000000"],
    defaultWei: "2000000000000000",
    quoteTtlSeconds: 60,
    l1GasFloor: "500000",
    l1GasCeiling: "1000000",
    l1GasMultiplier: 2,
    pollSeconds: 12,
  },
};

function memory(): JournalStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

function record(overrides: Partial<DepositRecord> = {}): DepositRecord {
  return {
    schemaVersion: 1,
    account: ACCOUNT,
    recipient: "0xa88f59f35864a15e3dc995c18f82bd815555e30e",
    amountWei: "2000000000000000",
    configVersion: cfg.configVersion,
    l1ChainId: cfg.l1.chainId,
    l2ChainId: cfg.l2.chainId,
    l2GenesisHash: cfg.l2.genesisHash,
    l1Hash: HASH,
    phase: "l1-pending",
    submittedAt: 10,
    ...overrides,
  };
}

function envelope(records: unknown[], patch: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    l1ChainId: cfg.l1.chainId,
    l2ChainId: cfg.l2.chainId,
    l2GenesisHash: cfg.l2.genesisHash,
    account: ACCOUNT.toLowerCase(),
    records,
    ...patch,
  });
}

describe("journal", () => {
  it("keys storage by chain, genesis, and the lowercased account", () => {
    const storage = memory();
    const journal = createJournal({ storage, cfg, account: ACCOUNT });
    const expected = `fortel2-bridge:v1:${cfg.l1.chainId}:${cfg.l2.chainId}:${cfg.l2.genesisHash}:${ACCOUNT.toLowerCase()}`;
    expect(journal.key).toBe(expected);
    journal.upsert(record());
    expect([...storage.data.keys()]).toEqual([expected]);
  });

  it("dedupes on l1 hash and sums each fee once", () => {
    const journal = createJournal({ storage: memory(), cfg, account: ACCOUNT });
    journal.upsert(record({ actualL1FeeWei: "10" }));
    journal.upsert(record({ l1Hash: HASH.toUpperCase(), actualL1FeeWei: "4" }));
    journal.upsert(record({ l1Hash: OTHER, actualL1FeeWei: "6" }));
    expect(journal.list()).toHaveLength(2);
    expect(journal.totalActualFeesWei()).toBe("10");
    journal.remove(HASH.toUpperCase());
    expect(journal.list().map((item) => item.l1Hash)).toEqual([OTHER]);
    expect(journal.totalActualFeesWei()).toBe("6");
    journal.clear();
    expect(journal.list()).toEqual([]);
    expect(journal.totalActualFeesWei()).toBe("0");
  });

  it("round-trips exportJson for a pending record", () => {
    const journal = createJournal({ storage: memory(), cfg, account: ACCOUNT });
    journal.upsert(record());
    const json = journal.exportJson();
    const other = createJournal({ cfg, account: ACCOUNT });
    expect(other.importJson(json)).toEqual({ accepted: 1, refused: 0 });
    expect(other.list()).toEqual(journal.list());
    expect(other.exportJson()).toBe(json);
  });

  it("strips a forged replica-confirmed import back to l1-pending", () => {
    const journal = createJournal({ storage: memory(), cfg, account: ACCOUNT });
    const forged = record({
      phase: "replica-confirmed",
      l2Hash: FORGED_L2,
      sourceHash: FORGED_L2,
      l1BlockHash: FORGED_L2,
      depositLogIndex: 4,
      nonce: 3,
      actualL1FeeWei: "99",
      l1GasUsed: "1",
      effectiveGasPriceWei: "2",
      l1IncludedObservedAt: 1,
      l2ObservedAt: 2,
      replicaObservedAt: 3,
      lastProvenPhase: "replica-confirmed",
      lastError: "forged",
    });
    expect(journal.importJson(envelope([forged, { ...forged, actualL1FeeWei: "99" }]))).toEqual({
      accepted: 2,
      refused: 0,
    });
    expect(journal.list()).toHaveLength(1);
    const [imported] = journal.list();
    expect(imported?.phase).toBe("l1-pending");
    expect(imported?.l2Hash).toBeUndefined();
    expect(imported?.sourceHash).toBeUndefined();
    expect(imported?.l1BlockHash).toBeUndefined();
    expect(imported?.depositLogIndex).toBeUndefined();
    expect(imported?.nonce).toBeUndefined();
    expect(imported?.actualL1FeeWei).toBeUndefined();
    expect(imported?.l1IncludedObservedAt).toBeUndefined();
    expect(imported?.l2ObservedAt).toBeUndefined();
    expect(imported?.replicaObservedAt).toBeUndefined();
    expect(imported?.lastProvenPhase).toBeUndefined();
    expect(journal.totalActualFeesWei()).toBe("0");
  });

  it("refuses the wrong genesis, chain, or account", () => {
    const journal = createJournal({ storage: memory(), cfg, account: ACCOUNT });
    const good = record();
    expect(journal.importJson(envelope([good], { l2GenesisHash: `0x${"00".repeat(32)}` })).accepted).toBe(0);
    expect(journal.importJson(envelope([good], { l1ChainId: 1 })).accepted).toBe(0);
    expect(journal.importJson(envelope([good], { account: `0x${"11".repeat(20)}` })).accepted).toBe(0);
    const wrongRecord = record({ account: `0x${"11".repeat(20)}` });
    const mixed = journal.importJson(envelope([wrongRecord, good]));
    expect(mixed).toEqual({ accepted: 1, refused: 1 });
    expect(journal.list()).toHaveLength(1);
    expect(journal.importJson(envelope([{ ...good, schemaVersion: 2 }])).refused).toBe(1);
    expect(journal.list()).toHaveLength(1);
  });

  it("keeps working in memory when storage throws or is absent", () => {
    const throwing: JournalStorage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    const journal = createJournal({ storage: throwing, cfg, account: ACCOUNT });
    journal.upsert(record({ actualL1FeeWei: "3" }));
    expect(journal.list()).toHaveLength(1);
    expect(journal.totalActualFeesWei()).toBe("3");
    expect(journal.exportJson()).toContain(HASH);
    journal.remove(HASH);
    expect(journal.list()).toEqual([]);

    const absent = createJournal({ cfg, account: ACCOUNT });
    absent.upsert(record({ actualL1FeeWei: "8" }));
    expect(absent.list()).toHaveLength(1);
    expect(absent.totalActualFeesWei()).toBe("8");
    absent.clear();
    expect(absent.list()).toEqual([]);
  });

  it("reloads a stored success as a hint and does not double a fee", () => {
    const storage = memory();
    const journal = createJournal({ storage, cfg, account: ACCOUNT });
    journal.upsert(record({ phase: "replica-confirmed", l2Hash: FORGED_L2, actualL1FeeWei: "15" }));
    const reloaded = createJournal({ storage, cfg, account: ACCOUNT });
    expect(reloaded.list()[0]?.phase).toBe("replica-confirmed");
    expect(reloaded.list()[0]?.l2Hash).toBe(FORGED_L2);
    expect(reloaded.totalActualFeesWei()).toBe("15");
    reloaded.importJson(reloaded.exportJson());
    expect(reloaded.list()[0]?.phase).toBe("l1-pending");
    expect(reloaded.list()[0]?.l2Hash).toBeUndefined();
    expect(reloaded.totalActualFeesWei()).toBe("0");
  });
});
