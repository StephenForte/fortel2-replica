import { getAddress } from "ethers";
import { describe, expect, it } from "vitest";

import bridgeConfig from "../bridge-config.json";
import { encodeDepositCall } from "../src/bridge-protocol";
import { submitDeposit, DepositInFlightError, type SubmitDeps, type SubmitResult } from "../src/deposit";
import { createQuote, type QuoteContext } from "../src/quote";
import type { RpcClient } from "../src/rpc";
import type { BridgeConfig, DepositQuote } from "../src/types";
import { createMockEip1193, type MockEip1193 } from "./mock-eip1193";

const cfg = bridgeConfig as BridgeConfig;
const ACCOUNT = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const OTHER = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const HASH = `0x${"ab".repeat(32)}`;
const AMOUNT_WEI = 2_000_000_000_000_000n;
const L1_GAS = 500_000n;

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function word(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function scripted(handlers: Record<string, () => unknown>): { client: RpcClient; calls: number } {
  let calls = 0;
  return {
    client: {
      async call(method: string) {
        calls += 1;
        const handler = handlers[method];
        if (!handler) throw new Error(`unexpected ${method}`);
        return handler();
      },
    },
    get calls() {
      return calls;
    },
  };
}

function chainClients(l1Chain: string = cfg.l1.chainIdHex) {
  const l1 = scripted({
    eth_chainId: () => l1Chain,
    eth_getCode: () => "0x6000",
    eth_call: () => word(cfg.contracts.systemConfig),
  });
  const sequencer = scripted({
    eth_chainId: () => cfg.l2.chainIdHex,
    eth_getBlockByNumber: () => ({ hash: cfg.l2.genesisHash }),
  });
  const replica = scripted({
    eth_chainId: () => cfg.l2.chainIdHex,
    eth_getBlockByNumber: () => ({ hash: cfg.l2.genesisHash }),
  });
  return { l1, sequencer, replica };
}

async function quoted(options: { estimate: bigint; legacy?: boolean }): Promise<DepositQuote> {
  const provider = createMockEip1193();
  provider.handle("eth_estimateGas", () => hex(options.estimate));
  provider.handle("eth_getBlockByNumber", () => (options.legacy ? { baseFeePerGas: null } : { baseFeePerGas: "0x1" }));
  provider.handle("eth_maxPriorityFeePerGas", () => "0x1");
  provider.handle("eth_gasPrice", () => "0x1");
  provider.handle("eth_getBalance", () => hex(10n ** 24n));
  const replica = scripted({ eth_getCode: () => "0x" });
  return createQuote(
    { amount: "0.002", recipient: ACCOUNT, account: ACCOUNT },
    { cfg, replica: replica.client, wallet: provider, now: () => 1_700_000_000_000 },
  );
}

function ctx(quote: DepositQuote, patch: Partial<QuoteContext> = {}): QuoteContext {
  return {
    account: quote.account,
    recipient: quote.recipient,
    amountWei: quote.amountWei,
    configVersion: quote.configVersion,
    chainId: quote.l1ChainId,
    ...patch,
  };
}

function submitter(options: {
  quote: DepositQuote;
  now: number;
  context?: QuoteContext;
  l1Chain?: string;
  balance?: string;
  send?: (callIndex: number) => unknown;
  onHash?: SubmitDeps["onHash"];
}): { deps: SubmitDeps; provider: MockEip1193; l1Calls: { readonly calls: number } } {
  const provider = createMockEip1193();
  provider.handle("eth_chainId", () => "0xaa36a7");
  provider.handle("eth_getBalance", () => options.balance ?? hex(10n ** 24n));
  provider.handle("eth_sendTransaction", (_params, callIndex) => {
    if (options.send) return options.send(callIndex);
    return HASH;
  });
  const chains = chainClients(options.l1Chain);
  const deps: SubmitDeps = {
    provider,
    cfg,
    l1: chains.l1.client,
    sequencer: chains.sequencer.client,
    replica: chains.replica.client,
    now: () => options.now,
    ctx: options.context ?? ctx(options.quote),
    onHash: options.onHash ?? (async () => undefined),
  };
  return { deps, provider, l1Calls: chains.l1 };
}

describe("submitDeposit", () => {
  it("sends the frozen quote once and persists the hash before resolving", async () => {
    const quote = await quoted({ estimate: 100_000n });
    const order: string[] = [];
    let seenHash = "";
    const { deps, provider } = submitter({
      quote,
      now: quote.createdAt,
      onHash: async (record) => {
        order.push("onHash");
        seenHash = record.l1Hash;
        expect(record.phase).toBe("l1-pending");
        expect(record.schemaVersion).toBe(1);
        expect(record.amountWei).toBe(quote.amountWei);
        expect(record.recipient).toBe(quote.recipient);
        expect(record.account).toBe(quote.account);
        expect(record.configVersion).toBe(quote.configVersion);
        await Promise.resolve();
        order.push("onHash-done");
      },
    });

    const result = await submitDeposit(quote, deps);
    order.push("resolved");

    expect(order).toEqual(["onHash", "onHash-done", "resolved"]);
    expect(result).toMatchObject({ kind: "submitted", record: { l1Hash: HASH, phase: "l1-pending", submittedAt: quote.createdAt } });
    expect(seenHash).toBe(HASH);
    expect(provider.requests.map((entry) => entry.method)).toEqual([
      "eth_chainId",
      "eth_getBalance",
      "eth_sendTransaction",
    ]);

    const tx = (provider.calls("eth_sendTransaction")[0]?.params as Record<string, string>[])[0];
    expect(tx).toEqual({
      from: quote.account,
      to: quote.portal,
      value: "0x71afd498d0000",
      data: quote.data,
      gas: "0x7a120",
      maxFeePerGas: hex(BigInt(quote.maxFeePerGasWei ?? "0")),
      maxPriorityFeePerGas: hex(BigInt(quote.maxPriorityFeePerGasWei ?? "0")),
    });
    expect(tx.value).toBe(hex(AMOUNT_WEI));
    expect(BigInt("0x71afd498d0000")).toBe(AMOUNT_WEI);
    expect(tx.data).toBe(encodeDepositCall(quote.recipient, AMOUNT_WEI, 100_000n));
    expect(tx.gas).toBe(hex(L1_GAS));
    expect(tx.gas).not.toBe("0x186a0");
    expect(tx).not.toHaveProperty("gasPrice");
    expect(tx).not.toHaveProperty("gasLimit");
  });

  it("sends a legacy gasPrice from the quote and not a rebuilt fee", async () => {
    const quote = await quoted({ estimate: 400_000n, legacy: true });
    const { deps, provider } = submitter({ quote, now: quote.createdAt });
    const result = await submitDeposit(quote, deps);
    expect(result.kind).toBe("submitted");
    const tx = (provider.calls("eth_sendTransaction")[0]?.params as Record<string, string>[])[0];
    expect(tx.gasPrice).toBe(hex(BigInt(quote.gasPriceWei ?? "0")));
    expect(tx.value).toBe("0x71afd498d0000");
    expect(tx.data).toBe(quote.data);
    expect(tx.gas).toBe(hex(800_000n));
    expect(tx).not.toHaveProperty("maxFeePerGas");
    expect(provider.calls("eth_sendTransaction")).toHaveLength(1);
    expect(provider.calls("eth_estimateGas")).toHaveLength(0);
    expect(provider.calls("eth_gasPrice")).toHaveLength(0);
  });

  it("sends nothing when the quote is expired at 60 seconds", async () => {
    const quote = await quoted({ estimate: 100_000n });
    const { deps, provider, l1Calls } = submitter({ quote, now: quote.expiresAt });
    const result = await submitDeposit(quote, deps);
    expect(result).toMatchObject({ kind: "blocked" });
    expect(provider.requests).toHaveLength(0);
    expect(l1Calls.calls).toBe(0);
  });

  it.each([
    ["account", { account: OTHER }],
    ["chain", { chainId: "0x1" }],
    ["recipient", { recipient: OTHER }],
    ["config version", { configVersion: "other" }],
  ] as const)("sends nothing after a %s change", async (_label, patch) => {
    const quote = await quoted({ estimate: 100_000n });
    const { deps, provider, l1Calls } = submitter({
      quote,
      now: quote.createdAt,
      context: ctx(quote, patch),
    });
    const result = await submitDeposit(quote, deps);
    expect(result).toMatchObject({ kind: "blocked" });
    expect(provider.requests).toHaveLength(0);
    expect(l1Calls.calls).toBe(0);
  });

  it("sends nothing when verification mismatches at submit time", async () => {
    const quote = await quoted({ estimate: 100_000n });
    const { deps, provider } = submitter({ quote, now: quote.createdAt, l1Chain: "0x1" });
    const result = await submitDeposit(quote, deps);
    expect(result).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/L1 chain/) });
    expect(provider.calls("eth_sendTransaction")).toHaveLength(0);
    expect(provider.calls("eth_getBalance")).toHaveLength(0);
    expect(provider.requests.map((entry) => entry.method)).toEqual(["eth_chainId"]);
  });

  it("sends nothing when the balance can no longer cover the quote", async () => {
    const quote = await quoted({ estimate: 100_000n });
    const { deps, provider } = submitter({ quote, now: quote.createdAt, balance: "0x0" });
    const result = await submitDeposit(quote, deps);
    expect(result).toEqual({ kind: "blocked", reason: "insufficient balance" });
    expect(provider.calls("eth_sendTransaction")).toHaveLength(0);
  });

  it("lets a second click issue no provider request while the first send is open", async () => {
    const quote = await quoted({ estimate: 100_000n });
    let resolveSend: ((hash: string) => void) | undefined;
    let markSent: (() => void) | undefined;
    const sendStarted = new Promise<void>((resolve) => {
      markSent = resolve;
    });
    const { deps, provider } = submitter({
      quote,
      now: quote.createdAt,
      send: () => {
        markSent?.();
        return new Promise<string>((resolve) => {
          resolveSend = resolve;
        });
      },
    });

    const first = submitDeposit(quote, deps);
    const beforeSecond = provider.requests.length;
    const second = submitDeposit(quote, deps);
    expect(provider.requests.length).toBe(beforeSecond);
    await expect(second).rejects.toBeInstanceOf(DepositInFlightError);

    await sendStarted;
    expect(provider.calls("eth_sendTransaction")).toHaveLength(1);
    resolveSend?.(HASH);
    await expect(first).resolves.toMatchObject({ kind: "submitted" });
    expect(provider.calls("eth_sendTransaction")).toHaveLength(1);
  });

  it("maps 4001 to wallet-rejected and does not retry", async () => {
    const quote = await quoted({ estimate: 100_000n });
    const { deps, provider } = submitter({
      quote,
      now: quote.createdAt,
      send: () => {
        throw Object.assign(new Error("rejected"), { code: 4001 });
      },
    });
    await expect(submitDeposit(quote, deps)).resolves.toEqual({ kind: "wallet-rejected" });
    expect(provider.calls("eth_sendTransaction")).toHaveLength(1);
  });

  it("treats a thrown timeout as uncertain and does not retry", async () => {
    const quote = await quoted({ estimate: 100_000n });
    let hashes = 0;
    const { deps, provider } = submitter({
      quote,
      now: quote.createdAt,
      onHash: () => {
        hashes += 1;
      },
      send: () => {
        throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      },
    });
    const result: SubmitResult = await submitDeposit(quote, deps);
    expect(result.kind).toBe("uncertain");
    if (result.kind === "uncertain") {
      expect(result.guidance).toMatch(/MetaMask activity/);
      expect(result.guidance).toMatch(/paste the hash/i);
    }
    expect(provider.calls("eth_sendTransaction")).toHaveLength(1);
    expect(hashes).toBe(0);
  });

  it("does not report success when persisting the hash throws", async () => {
    const quote = await quoted({ estimate: 100_000n });
    const { deps, provider } = submitter({
      quote,
      now: quote.createdAt,
      onHash: () => {
        throw new Error("journal failed");
      },
    });
    const result = await submitDeposit(quote, deps);
    expect(result.kind).toBe("uncertain");
    if (result.kind === "uncertain") {
      expect(result.guidance).toContain(HASH);
      expect(result.guidance).toMatch(/MetaMask activity/);
    }
    expect(provider.calls("eth_sendTransaction")).toHaveLength(1);
  });

  it("treats a malformed hash as uncertain and does not persist it", async () => {
    const quote = await quoted({ estimate: 100_000n });
    let hashes = 0;
    const { deps, provider } = submitter({
      quote,
      now: quote.createdAt,
      onHash: () => {
        hashes += 1;
      },
      send: () => "0x1234",
    });
    const result = await submitDeposit(quote, deps);
    expect(result.kind).toBe("uncertain");
    expect(provider.calls("eth_sendTransaction")).toHaveLength(1);
    expect(hashes).toBe(0);
  });
});
