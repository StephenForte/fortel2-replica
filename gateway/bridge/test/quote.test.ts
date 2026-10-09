import { getAddress } from "ethers";
import { describe, expect, it } from "vitest";

import bridgeConfig from "../bridge-config.json";
import { ProtocolError, encodeDepositCall } from "../src/bridge-protocol";
import { QuoteError, createQuote, isQuoteValid, type QuoteContext } from "../src/quote";
import type { RpcClient } from "../src/rpc";
import type { BridgeConfig } from "../src/types";
import { createMockEip1193, type MockEip1193 } from "./mock-eip1193";

const cfg = bridgeConfig as BridgeConfig;
const ACCOUNT = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const OTHER = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const CREATED_AT = 1_700_000_000_000;
const AMOUNT_WEI = 2_000_000_000_000_000n;

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function delegation(address: string): string {
  return `0xef0100${address.slice(2).toLowerCase()}`;
}

type Replica = { client: RpcClient; readonly calls: number };

function codeAt(code: string): Replica {
  let calls = 0;
  return {
    client: {
      async call(method: string) {
        calls += 1;
        if (method !== "eth_getCode") throw new Error(method);
        return code;
      },
    },
    get calls() {
      return calls;
    },
  };
}

function wallet(options: {
  estimate: bigint;
  balance?: bigint;
  baseFee?: string | null;
  priority?: bigint;
  priorityResult?: unknown;
  priorityThrows?: boolean;
  gasPrice?: bigint;
  feeHistory?: unknown;
  feeHistoryThrows?: boolean;
}): { provider: MockEip1193; order: string[] } {
  const provider = createMockEip1193();
  const order: string[] = [];
  provider.handle("eth_estimateGas", () => {
    order.push("estimate");
    return hex(options.estimate);
  });
  provider.handle("eth_getBlockByNumber", () => {
    order.push("block");
    if (options.baseFee === undefined) return {};
    return { baseFeePerGas: options.baseFee };
  });
  provider.handle("eth_maxPriorityFeePerGas", () => {
    order.push("priority");
    if (options.priorityThrows) throw new Error("eth_maxPriorityFeePerGas unavailable");
    if (options.priorityResult !== undefined) return options.priorityResult;
    return hex(options.priority ?? 0n);
  });
  provider.handle("eth_feeHistory", () => {
    order.push("feeHistory");
    if (options.feeHistoryThrows || options.feeHistory === undefined) {
      throw new Error("eth_feeHistory unavailable");
    }
    return options.feeHistory;
  });
  provider.handle("eth_gasPrice", () => {
    order.push("gasPrice");
    return hex(options.gasPrice ?? 0n);
  });
  provider.handle("eth_getBalance", () => {
    order.push("balance");
    return hex(options.balance ?? 10n ** 30n);
  });
  return { provider, order };
}

function idleL1(): RpcClient {
  return {
    async call(method: string): Promise<unknown> {
      throw new Error(`unexpected l1 ${method}`);
    },
  };
}

type L1Call = { method: string; params: readonly unknown[] | undefined };

function scriptedL1(result: unknown | (() => unknown)): { client: RpcClient; calls: L1Call[] } {
  const calls: L1Call[] = [];
  return {
    calls,
    client: {
      async call(method: string, params?: readonly unknown[]) {
        calls.push({ method, params });
        if (typeof result === "function") return result();
        return result;
      },
    },
  };
}

function rewards(...values: string[]): { reward: string[][] } {
  return { reward: values.map((value) => [value]) };
}

function codePair(replicaCode: string, sequencerCode = replicaCode) {
  return { replica: codeAt(replicaCode), sequencer: codeAt(sequencerCode) };
}

async function quoteWith(options: {
  estimate: bigint;
  code?: string;
  sequencerCode?: string;
  recipient?: string;
  account?: string;
  baseFee?: string | null;
  priority?: bigint;
  priorityResult?: unknown;
  priorityThrows?: boolean;
  gasPrice?: bigint;
  balance?: bigint;
  feeHistory?: unknown;
  feeHistoryThrows?: boolean;
  l1?: RpcClient;
}) {
  const l2 = codePair(options.code ?? "0x", options.sequencerCode ?? options.code ?? "0x");
  const node = wallet(options);
  const quote = await createQuote(
    {
      amount: "0.002",
      recipient: options.recipient ?? ACCOUNT,
      account: options.account ?? ACCOUNT,
    },
    {
      cfg,
      replica: l2.replica.client,
      sequencer: l2.sequencer.client,
      wallet: node.provider,
      l1: options.l1 ?? idleL1(),
      now: () => CREATED_AT,
    },
  );
  return { quote, l2, node };
}

function context(quote: { account: string; recipient: string; amountWei: string; configVersion: string; l1ChainId: number }): QuoteContext {
  return {
    account: quote.account,
    recipient: quote.recipient,
    amountWei: quote.amountWei,
    configVersion: quote.configVersion,
    chainId: quote.l1ChainId,
  };
}

describe("createQuote", () => {
  it("uses the floor when the doubled estimate is below 500000", async () => {
    const baseFee = 7_750_000_000_000_000n;
    const priority = 1n;
    const { quote, node } = await quoteWith({
      estimate: 100_000n,
      baseFee: hex(baseFee),
      priority,
    });

    expect(cfg.deposit.l1GasFloor).toBe("500000");
    expect(cfg.deposit.l1GasCeiling).toBe("1000000");
    expect(cfg.deposit.l1GasMultiplier).toBe(2);
    expect(cfg.deposit.quoteTtlSeconds).toBe(60);
    expect(quote.l1GasEstimate).toBe("100000");
    expect(quote.l1GasLimit).toBe("500000");
    expect(quote.l2GasLimit).toBe("100000");
    expect(quote.maxFeePerGasWei).toBe("15500000000000001");
    expect(quote.maxPriorityFeePerGasWei).toBe("1");
    expect(quote.gasPriceWei).toBeUndefined();
    expect(quote.maxNetworkFeeWei).toBe("7750000000000000500000");
    expect(quote.amountWei).toBe(AMOUNT_WEI.toString());
    expect(quote.maxWalletDebitWei).toBe("7750002000000000500000");
    expect(baseFee * 2n + priority).toBe(15_500_000_000_000_001n);
    expect(500_000n * 15_500_000_000_000_001n).toBe(7_750_000_000_000_000_500_000n);
    expect(quote.expiresAt).toBe(CREATED_AT + 60_000);
    expect(node.order).toEqual(["estimate", "block", "priority", "balance"]);
    expect(node.provider.calls("eth_gasPrice")).toHaveLength(0);
    expect(quote.data).toBe(encodeDepositCall(ACCOUNT, AMOUNT_WEI, 100_000n));
    const estimated = node.provider.calls("eth_estimateGas")[0]?.params as Record<string, string>[];
    expect(estimated[0]).toMatchObject({
      from: quote.account,
      to: cfg.contracts.optimismPortal,
      value: "0x71afd498d0000",
      data: quote.data,
    });
  });

  it("doubles a 400000 estimate on a legacy chain and keeps the product exact", async () => {
    const gasPrice = 1_234_567_890_123_456_789n;
    const { quote, node } = await quoteWith({
      estimate: 400_000n,
      baseFee: null,
      gasPrice,
    });

    expect(quote.l1GasEstimate).toBe("400000");
    expect(quote.l1GasLimit).toBe("800000");
    expect(quote.gasPriceWei).toBe("1234567890123456789");
    expect(quote.maxFeePerGasWei).toBeUndefined();
    expect(quote.maxPriorityFeePerGasWei).toBeUndefined();
    expect(quote.maxNetworkFeeWei).toBe("987654312098765431200000");
    expect(quote.maxWalletDebitWei).toBe("987654314098765431200000");
    expect(800_000n * gasPrice).toBe(987_654_312_098_765_431_200_000n);
    expect(node.order).toEqual(["estimate", "block", "gasPrice", "balance"]);
    expect(node.provider.calls("eth_maxPriorityFeePerGas")).toHaveLength(0);
  });

  it("blocks an estimate whose doubled limit exceeds 1000000", async () => {
    const l2 = codePair("0x");
    const node = wallet({ estimate: 600_000n, baseFee: hex(1n) });
    await expect(
      createQuote(
        { amount: "0.002", recipient: ACCOUNT, account: ACCOUNT },
        {
          cfg,
          replica: l2.replica.client,
          sequencer: l2.sequencer.client,
          wallet: node.provider,
          l1: idleL1(),
          now: () => CREATED_AT,
        },
      ),
    ).rejects.toThrow(/1200000 exceeds the ceiling of 1000000/);
    expect(node.order).toEqual(["estimate"]);
    expect(node.provider.calls("eth_getBalance")).toHaveLength(0);
    expect(node.provider.calls("eth_getBlockByNumber")).toHaveLength(0);
  });

  it("blocks when the balance cannot cover the quoted debit", async () => {
    await expect(quoteWith({ estimate: 100_000n, baseFee: hex(1n), priority: 1n, balance: 0n })).rejects.toThrow(
      "insufficient balance",
    );
  });

  it("rejects a contract recipient before estimating gas", async () => {
    const l2 = codePair("0x6000");
    const node = wallet({ estimate: 100_000n, baseFee: hex(1n) });
    const error = await createQuote(
      { amount: "0.002", recipient: OTHER, account: ACCOUNT },
      {
        cfg,
        replica: l2.replica.client,
        sequencer: l2.sequencer.client,
        wallet: node.provider,
        l1: idleL1(),
        now: () => CREATED_AT,
      },
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(QuoteError);
    expect((error as QuoteError).message).toMatch(/contract/);
    expect(l2.replica.calls).toBe(1);
    expect(l2.sequencer.calls).toBe(1);
    expect(node.provider.calls("eth_estimateGas")).toHaveLength(0);
  });

  it("rejects an address the replica still reports as empty when the sequencer has code", async () => {
    const l2 = codePair("0x", "0x6000");
    const node = wallet({ estimate: 100_000n, baseFee: hex(1n) });
    await expect(
      createQuote(
        { amount: "0.002", recipient: OTHER, account: ACCOUNT },
        {
          cfg,
          replica: l2.replica.client,
          sequencer: l2.sequencer.client,
          wallet: node.provider,
          l1: idleL1(),
          now: () => CREATED_AT,
        },
      ),
    ).rejects.toThrow(/differs between sequencer and replica/);
    expect(node.provider.calls("eth_estimateGas")).toHaveLength(0);
  });

  it("allows an EIP-7702 designator only for the connected account", async () => {
    const allowed = await quoteWith({
      estimate: 100_000n,
      baseFee: hex(1n),
      priority: 1n,
      code: delegation(ACCOUNT),
      recipient: ACCOUNT,
      account: ACCOUNT,
    });
    expect(allowed.quote.recipient).toBe(ACCOUNT);
    expect(allowed.node.provider.calls("eth_estimateGas")).toHaveLength(1);

    const l2 = codePair(delegation(OTHER));
    const node = wallet({ estimate: 100_000n, baseFee: hex(1n) });
    await expect(
      createQuote(
        { amount: "0.002", recipient: OTHER, account: ACCOUNT },
        {
          cfg,
          replica: l2.replica.client,
          sequencer: l2.sequencer.client,
          wallet: node.provider,
          l1: idleL1(),
          now: () => CREATED_AT,
        },
      ),
    ).rejects.toThrow(/EIP-7702/);
    expect(node.provider.calls("eth_estimateGas")).toHaveLength(0);

    const longer = codePair(`${delegation(ACCOUNT)}00`);
    const blocked = wallet({ estimate: 100_000n, baseFee: hex(1n) });
    await expect(
      createQuote(
        { amount: "0.002", recipient: ACCOUNT, account: ACCOUNT },
        {
          cfg,
          replica: longer.replica.client,
          sequencer: longer.sequencer.client,
          wallet: blocked.provider,
          l1: idleL1(),
          now: () => CREATED_AT,
        },
      ),
    ).rejects.toThrow(/contract/);
  });

  it("does not ask for code until the amount and recipient parse", async () => {
    const l2 = codePair("0x");
    const node = wallet({ estimate: 100_000n });
    const deps = {
      cfg,
      replica: l2.replica.client,
      sequencer: l2.sequencer.client,
      wallet: node.provider,
      l1: idleL1(),
      now: () => CREATED_AT,
    };
    await expect(createQuote({ amount: "0", recipient: ACCOUNT, account: ACCOUNT }, deps)).rejects.toBeInstanceOf(
      ProtocolError,
    );
    await expect(createQuote({ amount: "0.002", recipient: "0x123", account: ACCOUNT }, deps)).rejects.toBeInstanceOf(
      ProtocolError,
    );
    expect(l2.replica.calls).toBe(0);
    expect(l2.sequencer.calls).toBe(0);
    expect(node.provider.requests).toHaveLength(0);
  });

  it("returns a frozen quote", async () => {
    const { quote } = await quoteWith({ estimate: 100_000n, baseFee: hex(1n), priority: 1n });
    expect(Object.isFrozen(quote)).toBe(true);
    expect(() => {
      (quote as { amountWei: string }).amountWei = "1";
    }).toThrow(TypeError);
    expect(quote.amountWei).toBe(AMOUNT_WEI.toString());
  });

  it("treats a zero base fee as EIP-1559 and does not fall back to gasPrice", async () => {
    const { quote, node } = await quoteWith({
      estimate: 100_000n,
      baseFee: "0x0",
      priority: 5n,
    });
    expect(quote.maxFeePerGasWei).toBe("5");
    expect(quote.gasPriceWei).toBeUndefined();
    expect(node.provider.calls("eth_gasPrice")).toHaveLength(0);
    expect(node.provider.calls("eth_maxPriorityFeePerGas")).toHaveLength(1);
  });
});

describe("isQuoteValid", () => {
  it("fails closed when the clock, account, chain, recipient, amount, or config changes", async () => {
    const { quote } = await quoteWith({ estimate: 100_000n, baseFee: hex(1n), priority: 1n });
    const ctx = context(quote);
    expect(isQuoteValid(quote, ctx, quote.expiresAt - 1)).toBe(true);
    expect(isQuoteValid(quote, ctx, quote.expiresAt)).toBe(false);
    expect(isQuoteValid(quote, { ...ctx, account: quote.account.toLowerCase() }, quote.createdAt)).toBe(true);
    expect(isQuoteValid(quote, { ...ctx, account: OTHER }, quote.createdAt)).toBe(false);
    expect(isQuoteValid(quote, { ...ctx, chainId: "0xaa36a7" }, quote.createdAt)).toBe(true);
    expect(isQuoteValid(quote, { ...ctx, chainId: "0x1" }, quote.createdAt)).toBe(false);
    expect(isQuoteValid(quote, { ...ctx, recipient: quote.recipient.toLowerCase() }, quote.createdAt)).toBe(true);
    expect(isQuoteValid(quote, { ...ctx, recipient: OTHER }, quote.createdAt)).toBe(false);
    expect(isQuoteValid(quote, { ...ctx, amountWei: "1" }, quote.createdAt)).toBe(false);
    expect(isQuoteValid(quote, { ...ctx, configVersion: "other" }, quote.createdAt)).toBe(false);
  });
});

describe("priority fee source", () => {
  it("uses the feeHistory median when eth_maxPriorityFeePerGas throws and does not call L1", async () => {
    const l1 = scriptedL1("0x63");
    const { quote, node } = await quoteWith({
      estimate: 100_000n,
      baseFee: hex(1n),
      priorityThrows: true,
      feeHistory: rewards("0x10", "0x2", "0x3", "0x4", "0x5"),
      l1: l1.client,
    });
    expect(quote.maxPriorityFeePerGasWei).toBe("4");
    expect(quote.feeSource).toBe("wallet-feeHistory");
    expect(quote.maxFeePerGasWei).toBe("6");
    expect(node.provider.calls("eth_maxPriorityFeePerGas")).toHaveLength(1);
    expect(node.provider.calls("eth_feeHistory")).toEqual([
      { method: "eth_feeHistory", params: ["0x5", "latest", [50]] },
    ]);
    expect(l1.calls).toHaveLength(0);
    expect(Object.isFrozen(quote)).toBe(true);
  });

  it("uses the L1 client when the wallet throws on both priority methods", async () => {
    const l1 = scriptedL1("0x2a");
    const { quote, node } = await quoteWith({
      estimate: 100_000n,
      baseFee: hex(1n),
      priorityThrows: true,
      feeHistoryThrows: true,
      l1: l1.client,
    });
    expect(quote.feeSource).toBe("l1");
    expect(quote.maxPriorityFeePerGasWei).toBe("42");
    expect(quote.maxFeePerGasWei).toBe("44");
    expect(node.provider.calls("eth_maxPriorityFeePerGas")).toHaveLength(1);
    expect(node.provider.calls("eth_feeHistory")).toHaveLength(1);
    expect(l1.calls).toEqual([{ method: "eth_maxPriorityFeePerGas", params: [] }]);
  });

  it("throws priority fee unavailable when the wallet and the L1 client all fail", async () => {
    const l1 = scriptedL1(() => {
      throw new Error("l1 down");
    });
    const error = await quoteWith({
      estimate: 100_000n,
      baseFee: hex(1n),
      priorityThrows: true,
      feeHistoryThrows: true,
      l1: l1.client,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(QuoteError);
    expect(error).not.toBeNull();
    expect((error as QuoteError).message).toBe("priority fee unavailable");
    expect((error as QuoteError).unavailable).toBe(true);
    expect(l1.calls).toEqual([{ method: "eth_maxPriorityFeePerGas", params: [] }]);
  });

  it.each([
    ["missing reward", { oldestBlock: "0x1" }],
    ["a non-hex reward", rewards("0x10", "nope", "0x3", "0x4", "0x5")],
    ["fewer than 1 block", { reward: [] }],
  ])("falls through a malformed feeHistory (%s) to L1", async (_name, feeHistory) => {
    const l1 = scriptedL1("0x10");
    const { quote, node } = await quoteWith({
      estimate: 100_000n,
      baseFee: hex(1n),
      priorityThrows: true,
      feeHistory,
      l1: l1.client,
    });
    expect(quote.feeSource).toBe("l1");
    expect(quote.maxPriorityFeePerGasWei).toBe("16");
    expect(quote.maxPriorityFeePerGasWei).not.toBe("nope");
    expect(node.provider.calls("eth_feeHistory")).toHaveLength(1);
    expect(l1.calls).toEqual([{ method: "eth_maxPriorityFeePerGas", params: [] }]);
  });

  it("keeps today's numbers when the wallet answers eth_maxPriorityFeePerGas", async () => {
    const baseFee = 7_750_000_000_000_000n;
    const priority = 1n;
    const l1 = scriptedL1("0x63");
    const { quote, node } = await quoteWith({
      estimate: 100_000n,
      baseFee: hex(baseFee),
      priority,
      feeHistory: rewards("0x10", "0x2", "0x3", "0x4", "0x5"),
      l1: l1.client,
    });
    expect(quote.maxFeePerGasWei).toBe("15500000000000001");
    expect(quote.maxPriorityFeePerGasWei).toBe("1");
    expect(quote.gasPriceWei).toBeUndefined();
    expect(quote.maxNetworkFeeWei).toBe("7750000000000000500000");
    expect(quote.maxWalletDebitWei).toBe("7750002000000000500000");
    expect(quote.feeSource).toBe("wallet");
    expect(node.order).toEqual(["estimate", "block", "priority", "balance"]);
    expect(node.provider.calls("eth_maxPriorityFeePerGas")).toHaveLength(1);
    expect(node.provider.calls("eth_feeHistory")).toHaveLength(0);
    expect(l1.calls).toHaveLength(0);
  });

  it("treats a malformed wallet priority fee as that source failing", async () => {
    const l1 = scriptedL1("0x63");
    const { quote, node } = await quoteWith({
      estimate: 100_000n,
      baseFee: hex(1n),
      priorityResult: "nope",
      feeHistory: rewards("0x10", "0x2", "0x3", "0x4", "0x5"),
      l1: l1.client,
    });
    expect(quote.feeSource).toBe("wallet-feeHistory");
    expect(quote.maxPriorityFeePerGasWei).toBe("4");
    expect(node.provider.calls("eth_feeHistory")).toHaveLength(1);
    expect(l1.calls).toHaveLength(0);
  });

  it("treats a malformed L1 priority fee as unavailable and returns no quote", async () => {
    const l1 = scriptedL1("nope");
    const error = await quoteWith({
      estimate: 100_000n,
      baseFee: hex(1n),
      priorityThrows: true,
      feeHistoryThrows: true,
      l1: l1.client,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(QuoteError);
    expect((error as QuoteError).message).toBe("priority fee unavailable");
    expect((error as QuoteError).unavailable).toBe(true);
  });

  it("keeps a zero priority fee reported by the wallet", async () => {
    const l1 = scriptedL1("0x63");
    const { quote, node } = await quoteWith({
      estimate: 100_000n,
      baseFee: hex(1n),
      priority: 0n,
      feeHistory: rewards("0x10", "0x2", "0x3", "0x4", "0x5"),
      l1: l1.client,
    });
    expect(quote.maxPriorityFeePerGasWei).toBe("0");
    expect(quote.maxFeePerGasWei).toBe("2");
    expect(quote.feeSource).toBe("wallet");
    expect(node.provider.calls("eth_feeHistory")).toHaveLength(0);
    expect(l1.calls).toHaveLength(0);
  });
});
