import { readFileSync } from "node:fs";
import path from "node:path";
import { AbiCoder, Interface, concat, getAddress, getBytes, hexlify, zeroPadValue } from "ethers";
import { describe, expect, it } from "vitest";

import { RpcUnavailableError, type RpcClient } from "../src/rpc";
import { createPoller, createTracker, type PollerVisibility } from "../src/tracker";
import type { BridgeConfig, DepositRecord } from "../src/types";
import l1BlockFile from "./fixtures/b1-fixture-57b6-l1-block.json";
import l1ReceiptFile from "./fixtures/b1-fixture-57b6-l1-receipt.json";
import l1TxFile from "./fixtures/b1-fixture-57b6-l1-tx.json";
import l2ReceiptFile from "./fixtures/b1-fixture-57b6-l2-receipt.json";
import l2TxFile from "./fixtures/b1-fixture-57b6-l2-tx.json";

const L1_HASH = "0x57b64e5ba293e42bbc6d3ce9d5eebf39b909eebff84973d1f71c1b35c45d8fa3";
const L2_HASH = "0x6229a0743818135998ce745362f93b72dfca952e9cd1b71c1e81b54d3d2c53b9";
const SOURCE_HASH = "0xe020a2def6498d67eef5fc37796193bd43da221463ca384b915e38fa83794712";
const FEE = "566225880050665";
const ACCOUNT = "0xb84982a02a96c88676df643b6ee6b691bcded019";
const RECIPIENT = getAddress(String(l2TxFile.result.to));
const AMOUNT = BigInt(l2TxFile.result.mint).toString(10);

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

const portalAbi = new Interface([
  "function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable",
]);
const redeemAbi = new Interface([
  "function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)",
]);

type Row = { tx: Record<string, unknown>; receipt: Record<string, unknown> | null };

function chain(): {
  l1: Map<string, Row>;
  sequencer: Map<string, Row>;
  replica: Map<string, Row>;
  l1Blocks: Map<string, string>;
  sequencerBlocks: Map<string, string>;
  replicaBlocks: Map<string, string>;
  fail: { l1?: Error; sequencer?: Error; replica?: Error };
  calls: { l1: string[]; sequencer: string[]; replica: string[] };
} {
  const l1Tx = structuredClone(l1TxFile.result) as Record<string, unknown>;
  const l1Receipt = structuredClone(l1ReceiptFile.result) as Record<string, unknown>;
  const l2Tx = structuredClone(l2TxFile.result) as Record<string, unknown>;
  const l2Receipt = structuredClone(l2ReceiptFile.result) as Record<string, unknown>;
  const replicaTx = structuredClone(l2TxFile.result) as Record<string, unknown>;
  const replicaReceipt = structuredClone(l2ReceiptFile.result) as Record<string, unknown>;
  l2Tx.isSystemTx = null;
  replicaTx.isSystemTx = null;
  const l1 = new Map<string, Row>();
  const sequencer = new Map<string, Row>();
  const replica = new Map<string, Row>();
  l1.set(L1_HASH, { tx: l1Tx, receipt: l1Receipt });
  sequencer.set(L2_HASH, { tx: l2Tx, receipt: l2Receipt });
  replica.set(L2_HASH, { tx: replicaTx, receipt: replicaReceipt });
  const l1Blocks = new Map<string, string>([[String(l1Receipt.blockNumber).toLowerCase(), String(l1BlockFile.result.hash)]]);
  const l2Number = String(l2Receipt.blockNumber).toLowerCase();
  const l2Block = String(l2Receipt.blockHash);
  return {
    l1,
    sequencer,
    replica,
    l1Blocks,
    sequencerBlocks: new Map([[l2Number, l2Block]]),
    replicaBlocks: new Map([[l2Number, l2Block]]),
    fail: {},
    calls: { l1: [], sequencer: [], replica: [] },
  };
}

function client(
  rows: Map<string, Row>,
  blocks: Map<string, string>,
  fail: () => Error | undefined,
  calls: string[],
): RpcClient {
  return {
    async call(method, params = []) {
      calls.push(method);
      if (method === "eth_getBalance") throw new Error("balance is not evidence");
      const error = fail();
      if (error) throw error;
      const key = String(params[0] ?? "").toLowerCase();
      if (method === "eth_getTransactionByHash") return rows.get(key)?.tx ?? null;
      if (method === "eth_getTransactionReceipt") {
        const row = rows.get(key);
        if (!row) return null;
        return row.receipt;
      }
      if (method === "eth_getBlockByNumber") {
        const hash = blocks.get(key);
        if (hash === undefined) return null;
        return { number: params[0], hash };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

function trackerFor(world: ReturnType<typeof chain>, now: () => number = () => 1_700_000_000_000, config: BridgeConfig = cfg) {
  return createTracker({
    cfg: config,
    now,
    l1: client(world.l1, world.l1Blocks, () => world.fail.l1, world.calls.l1),
    sequencer: client(world.sequencer, world.sequencerBlocks, () => world.fail.sequencer, world.calls.sequencer),
    replica: client(world.replica, world.replicaBlocks, () => world.fail.replica, world.calls.replica),
  });
}

function seed(overrides: Partial<DepositRecord> = {}): DepositRecord {
  return {
    schemaVersion: 1,
    account: ACCOUNT,
    recipient: RECIPIENT,
    amountWei: AMOUNT,
    configVersion: cfg.configVersion,
    l1ChainId: cfg.l1.chainId,
    l2ChainId: cfg.l2.chainId,
    l2GenesisHash: cfg.l2.genesisHash,
    l1Hash: L1_HASH,
    phase: "l1-pending",
    ...overrides,
  };
}

function portalLog(world: ReturnType<typeof chain>): Record<string, unknown> {
  const receipt = world.l1.get(L1_HASH)?.receipt;
  if (!receipt || !Array.isArray(receipt.logs)) throw new Error("missing portal log");
  const log = receipt.logs[0];
  if (!log || typeof log !== "object") throw new Error("missing portal log");
  return log as Record<string, unknown>;
}

function withOpaque(log: Record<string, unknown>, edit: (bytes: Uint8Array) => void): void {
  const coder = AbiCoder.defaultAbiCoder();
  const decoded = coder.decode(["bytes"], String(log.data));
  const opaque = new Uint8Array(getBytes(decoded[0] as string));
  edit(opaque);
  log.data = coder.encode(["bytes"], [hexlify(opaque)]);
}

function rewriteWrapper(world: ReturnType<typeof chain>, executions: number, calldata?: string): void {
  const tx = world.l1.get(L1_HASH)?.tx;
  if (!tx || typeof tx.input !== "string") throw new Error("missing wrapper");
  const decoded = redeemAbi.decodeFunctionData("redeemDelegations", tx.input);
  const contexts = Array.from(decoded[0] as ArrayLike<string>);
  const modes = Array.from(decoded[1] as ArrayLike<string>);
  let packed = Array.from(decoded[2] as ArrayLike<string>);
  if (calldata !== undefined) {
    const bytes = getBytes(packed[0]);
    const inner = portalAbi.decodeFunctionData("depositTransaction", hexlify(bytes.subarray(52)));
    const next = portalAbi.encodeFunctionData("depositTransaction", [inner[0], inner[1], inner[2], inner[3], calldata]);
    packed = [hexlify(concat([bytes.subarray(0, 52), next]))];
  }
  tx.input = redeemAbi.encodeFunctionData("redeemDelegations", [
    Array.from({ length: executions }, () => contexts[0]),
    Array.from({ length: executions }, () => modes[0]),
    Array.from({ length: executions }, () => packed[0]),
  ]);
}

async function confirmed(world = chain(), now: () => number = () => 1_000) {
  const tracker = trackerFor(world, now);
  const input = seed();
  const record = await tracker.refresh(input);
  return { world, tracker, input, record };
}

describe("tracker refresh", () => {
  it("does not read eth_getBalance", () => {
    const source = readFileSync(path.join(process.cwd(), "src/tracker.ts"), "utf8");
    expect(source).not.toContain("eth_getBalance");
  });

  it("walks the 0x57b6 fixture to replica-confirmed", async () => {
    const { input, record } = await confirmed();
    expect(input.phase).toBe("l1-pending");
    expect(input.l2Hash).toBeUndefined();
    expect(record.phase).toBe("replica-confirmed");
    expect(record.l1Hash).toBe(L1_HASH);
    expect(record.sourceHash).toBe(SOURCE_HASH);
    expect(record.l2Hash).toBe(L2_HASH);
    expect(record.depositLogIndex).toBe(0x4f);
    expect(record.l1BlockHash).toBe(l1BlockFile.result.hash);
    expect(record.actualL1FeeWei).toBe(FEE);
    expect(record.l1GasUsed).toBe(BigInt(l1ReceiptFile.result.gasUsed).toString(10));
    expect(record.effectiveGasPriceWei).toBe(BigInt(l1ReceiptFile.result.effectiveGasPrice).toString(10));
    expect(record.nonce).toBe(3);
    expect(record.l1IncludedObservedAt).toBe(1_000);
    expect(record.l2ObservedAt).toBe(1_000);
    expect(record.replicaObservedAt).toBe(1_000);
    expect(record.lastError).toBeUndefined();
  });

  it("keeps the first observed-at timestamps", async () => {
    let clock = 1_000;
    const { tracker, record } = await confirmed(chain(), () => clock);
    clock = 9_000;
    const again = await tracker.refresh(record);
    expect(again.phase).toBe("replica-confirmed");
    expect(again.l1IncludedObservedAt).toBe(1_000);
    expect(again.l2ObservedAt).toBe(1_000);
    expect(again.replicaObservedAt).toBe(1_000);
    expect(again.lastCheckedAt).toBe(9_000);
  });

  it("stores the nonce while the receipt is missing and does not invent an L2 hash", async () => {
    const world = chain();
    const row = world.l1.get(L1_HASH);
    if (!row) throw new Error("missing l1");
    row.receipt = null;
    const record = await trackerFor(world).refresh(seed());
    expect(record.phase).toBe("l1-pending");
    expect(record.nonce).toBe(3);
    expect(record.l2Hash).toBeUndefined();
    expect(record.sourceHash).toBeUndefined();
    expect(record.actualL1FeeWei).toBeUndefined();
  });

  it.each([
    ["wrong event version", (world: ReturnType<typeof chain>) => {
      const log = portalLog(world);
      const topics = [...(log.topics as string[])];
      topics[3] = zeroPadValue("0x01", 32);
      log.topics = topics;
    }, /version/],
    ["wrong portal", (world: ReturnType<typeof chain>) => {
      portalLog(world).address = `0x${"33".repeat(20)}`;
    }, /TransactionDeposited/],
    ["amount mismatch", (world: ReturnType<typeof chain>) => {
      withOpaque(portalLog(world), (bytes) => {
        bytes.fill(0, 0, 64);
        bytes[31] = 1;
        bytes[63] = 1;
      });
    }, /amount/],
    ["recipient mismatch", (world: ReturnType<typeof chain>) => {
      const log = portalLog(world);
      const topics = [...(log.topics as string[])];
      topics[2] = zeroPadValue(`0x${"12".repeat(20)}`, 32);
      log.topics = topics;
    }, /recipient/],
    ["non-empty calldata", (world: ReturnType<typeof chain>) => {
      rewriteWrapper(world, 1, "0xabcd");
    }, /native deposit/],
    ["tampered sourceHash", (world: ReturnType<typeof chain>) => {
      const tx = world.sequencer.get(L2_HASH)?.tx;
      if (!tx) throw new Error("missing l2");
      tx.sourceHash = `0x${"11".repeat(32)}`;
    }, /sourceHash/],
    ["wrapper with 2 executions", (world: ReturnType<typeof chain>) => {
      rewriteWrapper(world, 2);
    }, /native deposit/],
    ["removed log", (world: ReturnType<typeof chain>) => {
      portalLog(world).removed = true;
    }, /removed/],
    ["two deposit logs", (world: ReturnType<typeof chain>) => {
      const receipt = world.l1.get(L1_HASH)?.receipt;
      if (!receipt || !Array.isArray(receipt.logs)) throw new Error("missing logs");
      receipt.logs = [receipt.logs[0], structuredClone(receipt.logs[0])];
    }, /TransactionDeposited/],
    ["isCreation event", (world: ReturnType<typeof chain>) => {
      withOpaque(portalLog(world), (bytes) => {
        bytes[72] = 1;
      });
    }, /isCreation/],
    ["isSystemTx true", (world: ReturnType<typeof chain>) => {
      const tx = world.sequencer.get(L2_HASH)?.tx;
      if (!tx) throw new Error("missing l2");
      tx.isSystemTx = true;
    }, /isSystemTx/],
  ])("rejects %s before l2-received", async (_name, mutate, reason) => {
    const world = chain();
    mutate(world);
    const record = await trackerFor(world).refresh(seed());
    expect(record.phase).not.toBe("l2-received");
    expect(record.phase).not.toBe("replica-confirmed");
    expect(record.phase).toBe("unsupported-deposit");
    expect(record.lastError).toMatch(reason);
  });

  it("rejects an intent amount or recipient that disagrees with the chain", async () => {
    const amount = await trackerFor(chain()).refresh(seed({ amountWei: "1" }));
    expect(amount.phase).toBe("unsupported-deposit");
    expect(amount.lastError).toMatch(/intent amount/);
    const recipient = await trackerFor(chain()).refresh(seed({ recipient: getAddress(`0x${"12".repeat(20)}`) }));
    expect(recipient.phase).toBe("unsupported-deposit");
    expect(recipient.lastError).toMatch(/intent recipient/);
  });

  it("drops a non-canonical L1 receipt back to l1-pending and clears the L2 hash", async () => {
    const { world, tracker, record } = await confirmed();
    expect(record.l2Hash).toBe(L2_HASH);
    const number = String(l1ReceiptFile.result.blockNumber).toLowerCase();
    world.l1Blocks.set(number, `0x${"ab".repeat(32)}`);
    const again = await tracker.refresh(record);
    expect(again.phase).toBe("l1-pending");
    expect(again.l2Hash).toBeUndefined();
    expect(again.sourceHash).toBeUndefined();
    expect(again.l1BlockHash).toBeUndefined();
    expect(again.depositLogIndex).toBeUndefined();
    expect(again.actualL1FeeWei).toBeUndefined();
    expect(again.l1IncludedObservedAt).toBeUndefined();
    expect(again.l2ObservedAt).toBeUndefined();
    expect(again.replicaObservedAt).toBeUndefined();
    expect(again.nonce).toBe(3);
  });

  it("records the L1 fee and stops on a reverted receipt", async () => {
    const world = chain();
    const receipt = world.l1.get(L1_HASH)?.receipt;
    if (!receipt) throw new Error("missing receipt");
    receipt.status = "0x0";
    const tracker = trackerFor(world);
    const record = await tracker.refresh(seed());
    expect(record.phase).toBe("l1-reverted");
    expect(record.actualL1FeeWei).toBe(FEE);
    expect(record.l2Hash).toBeUndefined();
    expect(record.lastError).toBe("l1 reverted");
    const again = await tracker.refresh(record);
    expect(again.phase).toBe("l1-reverted");
    expect(again.actualL1FeeWei).toBe(FEE);
  });

  it("reports l2 execution failure without calling it a refund", async () => {
    const world = chain();
    const receipt = world.sequencer.get(L2_HASH)?.receipt;
    if (!receipt) throw new Error("missing l2 receipt");
    receipt.status = "0x0";
    const record = await trackerFor(world).refresh(seed());
    expect(record.phase).toBe("l2-execution-failed");
    expect(record.l1Hash).toBe(L1_HASH);
    expect(record.l2Hash).toBe(L2_HASH);
    expect(record.lastError).toMatch(new RegExp(ACCOUNT, "i"));
    expect(record.lastError?.toLowerCase()).not.toContain("refund");
    expect(world.calls.replica).toEqual([]);
  });

  it("drops a stale replica observation when the replica no longer has the transaction", async () => {
    const { world, tracker, record } = await confirmed();
    expect(record.replicaObservedAt).toBe(1_000);
    world.replica.delete(L2_HASH);
    const again = await tracker.refresh(record);
    expect(again.phase).toBe("l2-received");
    expect(again.l2Hash).toBe(L2_HASH);
    expect(again.l2ObservedAt).toBe(1_000);
    expect(again.replicaObservedAt).toBeUndefined();
  });

  it("stays l2-received when the replica has not seen the transaction", async () => {
    const world = chain();
    world.replica.delete(L2_HASH);
    const record = await trackerFor(world).refresh(seed());
    expect(record.phase).toBe("l2-received");
    expect(record.l2Hash).toBe(L2_HASH);
    expect(record.replicaObservedAt).toBeUndefined();
  });

  it("stays l2-received when the replica receipt is in a different block", async () => {
    const world = chain();
    const receipt = world.replica.get(L2_HASH)?.receipt;
    if (!receipt) throw new Error("missing replica receipt");
    const other = `0x${"cd".repeat(32)}`;
    receipt.blockHash = other;
    world.replicaBlocks.set(String(receipt.blockNumber).toLowerCase(), other);
    const record = await trackerFor(world).refresh(seed());
    expect(record.phase).toBe("l2-received");
    expect(record.replicaObservedAt).toBeUndefined();
    expect(record.l2Hash).toBe(L2_HASH);
  });

  it.each(["l1", "sequencer", "replica"] as const)("keeps proven fields when %s is unavailable", async (role) => {
    const { world, tracker, record } = await confirmed();
    world.fail[role] = new RpcUnavailableError(`${role} down`);
    const paused = await tracker.refresh(record);
    expect(paused.phase).toBe("tracking-unavailable");
    expect(paused.lastProvenPhase).toBe("replica-confirmed");
    expect(paused.lastError).toBe(`${role} down`);
    expect(paused.l2Hash).toBe(L2_HASH);
    expect(paused.sourceHash).toBe(SOURCE_HASH);
    expect(paused.actualL1FeeWei).toBe(FEE);
    expect(paused.depositLogIndex).toBe(0x4f);
    delete world.fail[role];
    const again = await tracker.refresh(paused);
    expect(again.phase).toBe("replica-confirmed");
    expect(again.l2Hash).toBe(L2_HASH);
    expect(again.actualL1FeeWei).toBe(FEE);
  });

  it("treats a malformed receipt as no progress", async () => {
    const { world, tracker, record } = await confirmed();
    const row = world.l1.get(L1_HASH);
    if (!row) throw new Error("missing l1");
    row.receipt = { status: "yes" };
    const paused = await tracker.refresh(record);
    expect(paused.phase).toBe("tracking-unavailable");
    expect(paused.l2Hash).toBe(L2_HASH);
    expect(paused.actualL1FeeWei).toBe(FEE);
  });

  it("recovers a deposit from the hash alone and enforces the cap", async () => {
    const recovered = await trackerFor(chain()).recover(L1_HASH);
    expect(recovered.phase).toBe("replica-confirmed");
    expect(recovered.account.toLowerCase()).toBe(ACCOUNT);
    expect(recovered.recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(recovered.amountWei).toBe(AMOUNT);
    expect(recovered.l2Hash).toBe(L2_HASH);
    expect(recovered.actualL1FeeWei).toBe(FEE);

    const low: BridgeConfig = { ...cfg, deposit: { ...cfg.deposit, capWei: "1" } };
    const capped = await trackerFor(chain(), () => 1, low).recover(L1_HASH);
    expect(capped.phase).toBe("unsupported-deposit");
    expect(capped.lastError).toMatch(/cap/);
    expect(capped.phase).not.toBe("replica-confirmed");
  });
});

describe("replacement", () => {
  function addTx(world: ReturnType<typeof chain>, hash: string, tx: Record<string, unknown>, receipt: Record<string, unknown> | null) {
    world.l1.set(hash, { tx, receipt });
  }

  it("replaces the original when the new transaction repeats the nonce and the intent", async () => {
    const world = chain();
    const hash = `0x${"22".repeat(32)}`;
    const tx = structuredClone(world.l1.get(L1_HASH)?.tx);
    const receipt = structuredClone(world.l1.get(L1_HASH)?.receipt);
    if (!tx || !receipt) throw new Error("missing fixture");
    tx.hash = hash;
    receipt.transactionHash = hash;
    addTx(world, hash, tx, receipt);
    const original = seed({ nonce: 3, actualL1FeeWei: FEE, l2Hash: L2_HASH, phase: "l1-pending" });
    const linked = await trackerFor(world).linkReplacement(original, hash);
    expect(original.phase).toBe("l1-pending");
    expect(original.actualL1FeeWei).toBe(FEE);
    expect(linked.status).toBe("replaced");
    if (linked.status !== "replaced") return;
    expect(linked.original.phase).toBe("replaced");
    expect(linked.original.replacedBy).toBe(hash);
    expect(linked.original.actualL1FeeWei).toBeUndefined();
    expect(linked.original.l2Hash).toBeUndefined();
    expect(linked.replacement.replaces).toBe(L1_HASH);
    expect(linked.replacement.l1Hash).toBe(hash);
    expect(linked.replacement.actualL1FeeWei).toBe(FEE);
    expect(linked.replacement.phase).toBe("replica-confirmed");
  });

  it("cancels the original when the same nonce is a 0-value self-send", async () => {
    const world = chain();
    const hash = `0x${"23".repeat(32)}`;
    addTx(world, hash, { hash, from: ACCOUNT, to: ACCOUNT, nonce: "0x3", value: "0x0", input: "0x" }, null);
    const original = seed({ nonce: 3, actualL1FeeWei: "9", l2Hash: L2_HASH });
    const linked = await trackerFor(world).linkReplacement(original, hash);
    expect(linked.status).toBe("cancelled");
    if (linked.status !== "cancelled") return;
    expect(linked.original.phase).toBe("cancelled");
    expect(linked.original.actualL1FeeWei).toBeUndefined();
    expect(linked.original.l2Hash).toBeUndefined();
    expect(original.phase).toBe("l1-pending");
  });

  it("rejects a different nonce or a different sender", async () => {
    const world = chain();
    const nonceHash = `0x${"24".repeat(32)}`;
    const fromHash = `0x${"25".repeat(32)}`;
    const base = structuredClone(world.l1.get(L1_HASH)?.tx);
    if (!base) throw new Error("missing fixture");
    addTx(world, nonceHash, { ...base, hash: nonceHash, nonce: "0x4" }, null);
    addTx(world, fromHash, { ...base, hash: fromHash, from: `0x${"44".repeat(20)}` }, null);
    const tracker = trackerFor(world);
    const original = seed({ nonce: 3 });
    const wrongNonce = await tracker.linkReplacement(original, nonceHash);
    const wrongFrom = await tracker.linkReplacement(original, fromHash);
    expect(wrongNonce).toEqual({ status: "rejected", reason: "nonce mismatch" });
    expect(wrongFrom).toEqual({ status: "rejected", reason: "from mismatch" });
    expect(original.phase).toBe("l1-pending");
  });
});

describe("poller", () => {
  function timer() {
    let nextId = 1;
    const queue: { id: number; ms: number; fn: () => void }[] = [];
    const fired: number[] = [];
    return {
      fired,
      setTimeout(fn: () => void, ms: number) {
        const id = nextId;
        nextId += 1;
        queue.push({ id, ms, fn });
        return id;
      },
      clearTimeout(id: unknown) {
        const index = queue.findIndex((item) => item.id === id);
        if (index >= 0) queue.splice(index, 1);
      },
      fireNext() {
        const item = queue.shift();
        if (!item) return false;
        fired.push(item.ms);
        item.fn();
        return true;
      },
      pending() {
        return queue.map((item) => item.ms);
      },
    };
  }

  function visibility(): PollerVisibility & { set(state: "visible" | "hidden"): void } {
    let state: "visible" | "hidden" = "visible";
    const listeners = new Set<() => void>();
    return {
      get visibilityState() {
        return state;
      },
      addEventListener(_type, listener) {
        listeners.add(listener);
      },
      removeEventListener(_type, listener) {
        listeners.delete(listener);
      },
      set(next) {
        state = next;
        for (const listener of listeners) listener();
      },
    };
  }

  async function drain() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  it("never runs more than one refresh at a time", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const clock = timer();
    const poller = createPoller({
      intervalMs: 1_000,
      now: () => 0,
      timer: clock,
      visibility: visibility(),
      tracker: {
        async refresh(record) {
          calls += 1;
          await gate;
          return { ...record, phase: "l2-received" };
        },
      },
    });
    poller.watch(seed());
    poller.start();
    await drain();
    expect(calls).toBe(1);
    poller.start();
    expect(clock.fireNext()).toBe(true);
    await drain();
    expect(calls).toBe(1);
    release();
    await drain();
    expect(calls).toBe(1);
    expect(clock.fireNext()).toBe(true);
    await drain();
    expect(calls).toBe(2);
  });

  it("backs off after tracking-unavailable and caps at 120s", async () => {
    const clock = timer();
    let nowAt = 10_000;
    let calls = 0;
    const poller = createPoller({
      intervalMs: 30_000,
      now: () => nowAt,
      timer: clock,
      visibility: visibility(),
      tracker: {
        async refresh(record) {
          calls += 1;
          return { ...record, phase: "tracking-unavailable", lastError: "down", lastProvenPhase: "l1-pending" };
        },
      },
    });
    poller.watch(seed());
    poller.start();
    await drain();
    expect(calls).toBe(1);
    expect(poller.dueAt()).toBe(70_000);
    expect(clock.pending()).toEqual([60_000]);
    expect(clock.fireNext()).toBe(true);
    await drain();
    expect(clock.fireNext()).toBe(true);
    await drain();
    expect(clock.fireNext()).toBe(true);
    await drain();
    expect(clock.fired).toEqual([60_000, 120_000, 120_000]);
    expect(clock.pending()).toEqual([120_000]);
    expect(poller.dueAt()).toBe(nowAt + 120_000);
  });

  it("pauses while hidden and refreshes when shown", async () => {
    const clock = timer();
    const page = visibility();
    let calls = 0;
    const poller = createPoller({
      intervalMs: 5_000,
      now: () => 0,
      timer: clock,
      visibility: page,
      tracker: {
        async refresh(record) {
          calls += 1;
          return record;
        },
      },
    });
    poller.watch(seed());
    page.set("hidden");
    poller.start();
    await drain();
    expect(calls).toBe(0);
    page.set("visible");
    await drain();
    expect(calls).toBe(1);
    expect(clock.pending()).toEqual([5_000]);
    page.set("hidden");
    expect(clock.pending()).toEqual([]);
    expect(clock.fireNext()).toBe(false);
    await drain();
    expect(calls).toBe(1);
    page.set("visible");
    await drain();
    expect(calls).toBe(2);
  });

  it("stops polling terminal phases", async () => {
    const clock = timer();
    let calls = 0;
    const poller = createPoller({
      intervalMs: 1_000,
      now: () => 0,
      timer: clock,
      visibility: visibility(),
      tracker: {
        async refresh(record) {
          calls += 1;
          return { ...record, phase: "replica-confirmed" };
        },
      },
    });
    poller.watch(seed());
    poller.start();
    await drain();
    expect(calls).toBe(1);
    expect(poller.dueAt()).toBeNull();
    expect(clock.fireNext()).toBe(false);
    expect(calls).toBe(1);
    expect(poller.records()[0]?.phase).toBe("replica-confirmed");
  });
});
