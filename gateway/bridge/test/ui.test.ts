import { readFileSync } from "node:fs";
import { getAddress } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import bridgeConfig from "../bridge-config.json";
import { startBridge, type BridgeHandle } from "../src/ui/app";
import { transferredPrincipalWei } from "../src/ui/format";
import { renderProgressArticle } from "../src/ui/progress";
import type { BridgeConfig, DepositRecord } from "../src/types";
import type { DiscoveryTarget, DiscoveryTimer } from "../src/wallet";
import type { PollerTimer } from "../src/tracker";
import { createMockEip1193, type MockEip1193 } from "./mock-eip1193";

const cfg = bridgeConfig as BridgeConfig;
const ACCOUNT = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const OTHER = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const CREATED_AT = 1_700_000_000_000;
const HASH = `0x${"ab".repeat(32)}`;
const IMG = "<img src=x onerror=alert(1)>";

let nowMs = CREATED_AT;

const immediate: DiscoveryTimer = {
  setTimeout(callback) {
    callback();
    return 0;
  },
};

const quietPoller: PollerTimer = {
  setTimeout() {
    return 0;
  },
  clearTimeout() {},
};

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function word(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function mountPage(): void {
  const html = readFileSync("index.html", "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*>/gi, "");
  document.open();
  document.write(html);
  document.close();
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

function text(id: string): string {
  return byId(id).textContent ?? "";
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

type Rpc = (method: string, params: unknown[], url: string) => unknown;

function defaultRpc(method: string, params: unknown[], url: string): unknown {
  const l1 = url.includes("tenderly");
  if (method === "eth_chainId") return l1 ? cfg.l1.chainIdHex : cfg.l2.chainIdHex;
  if (method === "eth_getCode") {
    const address = String(params[0] ?? "").toLowerCase();
    if (address === cfg.contracts.optimismPortal.toLowerCase()) return "0x6000";
    return "0x";
  }
  if (method === "eth_call") return word(cfg.contracts.systemConfig);
  if (method === "eth_getBlockByNumber") {
    return l1 ? { baseFeePerGas: "0x1" } : { hash: cfg.l2.genesisHash };
  }
  if (method === "eth_getBalance") return hex(10n ** 21n);
  if (method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt") return null;
  throw new Error(`unexpected rpc ${method}`);
}

function installFetch(rpc: Rpc = defaultRpc, config: "ok" | "down" = "ok"): { calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("bridge-config.json")) {
      calls.push({ url, method: "GET" });
      if (config === "down") return new Response("no", { status: 503 });
      return new Response(JSON.stringify(cfg), { status: 200 });
    }
    const payload = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    calls.push({ url, method: payload.method });
    try {
      const result = await rpc(payload.method, payload.params ?? [], url);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), { status: 200 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "rpc failed";
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code: -32000, message } }),
        { status: 200 },
      );
    }
  });
  return { calls };
}

function arm(provider: MockEip1193, state: { accounts: string[]; chain: string }): void {
  provider.handle("eth_accounts", () => [...state.accounts]);
  provider.handle("eth_requestAccounts", () => {
    if (state.accounts.length === 0) state.accounts = [ACCOUNT];
    return [...state.accounts];
  });
  provider.handle("eth_chainId", () => state.chain);
  provider.handle("eth_getBalance", () => hex(10n ** 21n));
  provider.handle("eth_estimateGas", () => hex(100_000n));
  provider.handle("eth_getBlockByNumber", () => ({ baseFeePerGas: "0x1" }));
  provider.handle("eth_maxPriorityFeePerGas", () => "0x1");
  provider.handle("eth_gasPrice", () => "0x1");
  provider.handle("wallet_switchEthereumChain", () => null);
  provider.handle("wallet_addEthereumChain", () => null);
  provider.handle("eth_sendTransaction", () => HASH);
}

function targetFor(provider: MockEip1193 | null): DiscoveryTarget {
  const target: DiscoveryTarget = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  };
  if (provider) target.ethereum = provider;
  return target;
}

async function boot(options: {
  provider: MockEip1193 | null;
  accounts?: string[];
  chain?: string;
  rpc?: Rpc;
  config?: "ok" | "down";
}): Promise<{ handle: BridgeHandle; provider: MockEip1193 | null }> {
  const provider = options.provider;
  if (provider) {
    arm(provider, { accounts: options.accounts ?? [], chain: options.chain ?? "0xaa36a7" });
  }
  installFetch(options.rpc ?? defaultRpc, options.config ?? "ok");
  const handle = await startBridge({
    target: targetFor(provider),
    timer: immediate,
    windowMs: 0,
    now: () => nowMs,
    every() {
      return () => {};
    },
    pollerTimer: quietPoller,
  });
  await settle();
  return { handle, provider };
}

function journalKey(account: string): string {
  return `fortel2-bridge:v1:${cfg.l1.chainId}:${cfg.l2.chainId}:${cfg.l2.genesisHash}:${account.toLowerCase()}`;
}

function seedRecord(account: string, patch: Partial<DepositRecord> & Pick<DepositRecord, "l1Hash" | "phase">): void {
  const record: DepositRecord = {
    schemaVersion: 1,
    account,
    recipient: account,
    amountWei: "2000000000000000",
    configVersion: cfg.configVersion,
    l1ChainId: cfg.l1.chainId,
    l2ChainId: cfg.l2.chainId,
    l2GenesisHash: cfg.l2.genesisHash,
    ...patch,
  };
  const envelope = {
    schemaVersion: 1,
    l1ChainId: cfg.l1.chainId,
    l2ChainId: cfg.l2.chainId,
    l2GenesisHash: cfg.l2.genesisHash,
    account: account.toLowerCase(),
    records: [record],
  };
  localStorage.setItem(journalKey(account), JSON.stringify(envelope));
}

async function connectAndReview(provider: MockEip1193): Promise<void> {
  byId<HTMLButtonElement>("connect").click();
  await settle();
  byId<HTMLButtonElement>("review").click();
  await settle();
  expect(provider.calls("eth_sendTransaction")).toHaveLength(0);
  expect(byId<HTMLButtonElement>("approve").disabled).toBe(false);
}

beforeEach(() => {
  nowMs = CREATED_AT;
  localStorage.clear();
  mountPage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bridge page", () => {
  it("shows Brave guidance and does not connect", async () => {
    const brave = createMockEip1193({ isMetaMask: true, isBraveWallet: true });
    await boot({ provider: brave });
    const guidance = byId("wallet-guidance");
    expect(guidance.hidden).toBe(false);
    expect(guidance.textContent).toBe(
      "MetaMask extension on desktop Chrome or Brave is required. In Brave, set MetaMask as the default wallet.",
    );
    expect(text("config-status")).toBe("Connect MetaMask to run the network check.");
    expect(brave.calls("eth_requestAccounts")).toHaveLength(0);
    expect(brave.calls("eth_accounts")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/seed phrase|private key/i);
  });

  it("calls connect only after the click", async () => {
    const provider = createMockEip1193();
    await boot({ provider, accounts: [] });
    expect(provider.calls("eth_requestAccounts")).toHaveLength(0);
    expect(provider.calls("eth_accounts").length).toBeGreaterThan(0);
    byId<HTMLButtonElement>("connect").click();
    await settle();
    expect(provider.calls("eth_requestAccounts")).toHaveLength(1);
    expect(text("account")).toBe(ACCOUNT);
  });

  it("shows the review with exact formatted values", async () => {
    const provider = createMockEip1193();
    await boot({ provider, accounts: [] });
    await connectAndReview(provider);
    expect(text("review-source")).toBe("Sepolia");
    expect(text("review-destination")).toBe("ForteL2 Sepolia (852)");
    expect(text("review-recipient")).toBe(ACCOUNT);
    expect(text("review-amount")).toBe("0.002 ETH");
    expect(text("review-gas")).toBe("100000");
    expect(text("review-fee")).toBe("0.0000000000015 ETH");
    expect(text("review-debit")).toBe("0.0020000000015 ETH");
    expect(text("review-countdown")).toBe("Expires in 60s");
    expect(text("sepolia-balance")).toBe("1000 ETH");
    expect(text("sepolia-balance-time")).toBe(new Date(CREATED_AT).toISOString());
    expect(text("sepolia-balance-error")).toBe("");
    expect(text("forte-balance")).toMatch(/ ETH$/);
    expect(text("forte-balance-time")).toBe(new Date(CREATED_AT).toISOString());
    expect(text("forte-balance-error")).toBe("");
    expect(text("sepolia-balance-time")).not.toBe(text("amount-error"));
    const presets = [...byId("presets").querySelectorAll("button")].map((button) => button.textContent);
    expect(presets).toEqual(["0.001", "0.002", "0.005"]);
  });

  it("keeps Sepolia and ForteL2 balance failures apart", async () => {
    const provider = createMockEip1193();
    await boot({
      provider,
      accounts: [ACCOUNT],
      rpc(method, params, url) {
        if (method === "eth_getBalance" && !url.includes("tenderly")) throw new Error("replica down");
        return defaultRpc(method, params, url);
      },
    });
    expect(text("sepolia-balance-error")).toBe("");
    expect(text("sepolia-balance")).toMatch(/ ETH$/);
    expect(text("sepolia-balance-time")).toBe(new Date(CREATED_AT).toISOString());
    expect(text("forte-balance-error")).toBe("ForteL2 balance unavailable");
    expect(text("forte-balance")).toBe("–");
    expect(text("forte-balance-time")).toBe(new Date(CREATED_AT).toISOString());
  });

  it.each([
    ["accountsChanged", async (provider: MockEip1193) => provider.emit("accountsChanged", [OTHER])],
    ["chainChanged", async (provider: MockEip1193) => provider.emit("chainChanged", "0x1")],
    ["amount edit", async () => {
      const input = byId<HTMLInputElement>("amount");
      input.value = "0.001";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }],
    ["recipient edit", async () => {
      const input = byId<HTMLInputElement>("recipient");
      input.value = OTHER;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }],
    ["expiry", async (_provider: MockEip1193, handle: BridgeHandle) => {
      nowMs += 60_000;
      handle.tick();
    }],
  ])("disables Approve after %s and sends nothing", async (_name, mutate) => {
    const provider = createMockEip1193();
    const { handle } = await boot({ provider, accounts: [] });
    await connectAndReview(provider);
    await mutate(provider, handle);
    expect(byId<HTMLButtonElement>("approve").disabled).toBe(true);
    byId<HTMLButtonElement>("approve").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(provider.calls("eth_sendTransaction")).toHaveLength(0);
  });

  it("sends one transaction when Approve is clicked twice", async () => {
    const provider = createMockEip1193();
    let release: (value: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    await boot({ provider, accounts: [] });
    provider.handle("eth_sendTransaction", () => gate);
    await connectAndReview(provider);
    nowMs += 5;
    const approve = byId<HTMLButtonElement>("approve");
    approve.click();
    approve.click();
    expect(text("live")).toContain("Awaiting your wallet approval");
    expect(approve.disabled).toBe(true);
    await vi.waitFor(() => {
      expect(provider.calls("eth_sendTransaction")).toHaveLength(1);
    });
    release(HASH);
    await settle();
    expect(provider.calls("eth_sendTransaction")).toHaveLength(1);
    expect(text("deposit-result")).toContain(HASH);
    expect(byId("deposit-result").querySelector("a")?.getAttribute("href")).toBe(
      `https://sepolia.etherscan.io/tx/${HASH}`,
    );
    const stored = JSON.parse(localStorage.getItem(journalKey(ACCOUNT)) ?? "{}") as {
      records: { reviewedAt?: number; approvedAt?: number }[];
    };
    expect(stored.records[0]?.reviewedAt).toBe(CREATED_AT);
    expect(stored.records[0]?.approvedAt).toBe(CREATED_AT + 5);
  });

  it("disables Review and Approve when the config does not match", async () => {
    const provider = createMockEip1193();
    await boot({ provider, accounts: [ACCOUNT], chain: "0x1" });
    expect(text("config-status")).toContain("wallet chain is 0x1");
    expect(byId<HTMLButtonElement>("review").disabled).toBe(true);
    expect(byId<HTMLButtonElement>("approve").disabled).toBe(true);
    byId<HTMLButtonElement>("review").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    byId<HTMLButtonElement>("approve").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(provider.calls("eth_sendTransaction")).toHaveLength(0);
    expect(provider.calls("eth_estimateGas")).toHaveLength(0);
  });

  it("shows paste-hash recovery for an uncertain send and does not send again", async () => {
    const provider = createMockEip1193();
    await boot({ provider, accounts: [] });
    provider.handle("eth_sendTransaction", () => {
      throw Object.assign(new Error("dropped"), { code: -32603 });
    });
    await connectAndReview(provider);
    byId<HTMLButtonElement>("approve").click();
    await settle();
    expect(provider.calls("eth_sendTransaction")).toHaveLength(1);
    expect(byId("uncertain-recovery").hidden).toBe(false);
    expect(byId("paste-hash").tagName).toBe("INPUT");
    expect(text("live")).toContain("paste the hash");
    const labels = [...document.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels.some((label) => /resend/i.test(label))).toBe(false);
    byId<HTMLButtonElement>("approve").click();
    await settle();
    expect(provider.calls("eth_sendTransaction")).toHaveLength(1);
  });

  it("does not treat a stored replica confirmation as the current step when tracking is down", async () => {
    const observed = CREATED_AT - 5_000;
    seedRecord(ACCOUNT, {
      l1Hash: HASH,
      phase: "replica-confirmed",
      lastProvenPhase: "replica-confirmed",
      replicaObservedAt: observed,
      actualL1FeeWei: "1000",
    });
    const provider = createMockEip1193();
    await boot({
      provider,
      accounts: [ACCOUNT],
      rpc(method, params, url) {
        if (method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt") {
          throw new Error("tracking down");
        }
        return defaultRpc(method, params, url);
      },
    });
    const confirmed = document.querySelector('[data-step="confirmed"]');
    expect(confirmed?.getAttribute("data-state")).toBe("pending");
    expect(confirmed?.getAttribute("aria-current")).toBeNull();
    expect(document.querySelector('[data-state="done"]')).toBeNull();
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
    expect(text("progress-list")).toContain(
      `Last confirmed: Confirmed by replica at ${new Date(observed).toISOString()}. Rechecking…`,
    );
    expect(text("fee-total-value")).toBe("0.000000000000001 ETH");
    expect(text("principal-total-value")).toBe("0.002 ETH");
    expect(text("fee-total")).not.toContain("0.002");
    expect(text("history-list")).toContain("Actual L1 fee 0.000000000000001 ETH");
    expect(text("history-list")).toContain("Phase rechecking");
  });

  it("renders an imported replica-confirmed row as pending until the tracker proves it", async () => {
    const provider = createMockEip1193();
    await boot({ provider, accounts: [ACCOUNT] });
    const claimed = {
      schemaVersion: 1,
      l1ChainId: cfg.l1.chainId,
      l2ChainId: cfg.l2.chainId,
      l2GenesisHash: cfg.l2.genesisHash,
      account: ACCOUNT.toLowerCase(),
      records: [
        {
          schemaVersion: 1,
          account: ACCOUNT,
          recipient: ACCOUNT,
          amountWei: "2000000000000000",
          configVersion: cfg.configVersion,
          l1ChainId: cfg.l1.chainId,
          l2ChainId: cfg.l2.chainId,
          l2GenesisHash: cfg.l2.genesisHash,
          l1Hash: HASH,
          phase: "replica-confirmed",
          l2Hash: `0x${"cd".repeat(32)}`,
          replicaObservedAt: CREATED_AT,
        },
        { phase: "replica-confirmed" },
      ],
    };
    const file = new File([JSON.stringify(claimed)], "history.json", { type: "application/json" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = byId<HTMLInputElement>("import-file");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(text("import-result")).toBe("Accepted 1, refused 1.");
    const confirmed = document.querySelector('[data-step="confirmed"]');
    expect(confirmed?.getAttribute("data-state")).not.toBe("done");
    expect(confirmed?.getAttribute("aria-current")).toBeNull();
    expect(text("history-list")).not.toContain("Phase replica-confirmed");
    expect(text("history-list")).toContain("Phase l1-pending");
  });

  it("disables review when the network check is down", async () => {
    const provider = createMockEip1193();
    await boot({ provider, accounts: [ACCOUNT], config: "down" });
    expect(text("config-status")).toBe("network check unavailable");
    expect(byId<HTMLButtonElement>("review").disabled).toBe(true);
    expect(byId<HTMLButtonElement>("approve").disabled).toBe(true);
  });

  it("marks a step done only when this session's tracker returned that phase", () => {
    const record: DepositRecord = {
      schemaVersion: 1,
      account: ACCOUNT,
      recipient: ACCOUNT,
      amountWei: "2000000000000000",
      configVersion: cfg.configVersion,
      l1ChainId: cfg.l1.chainId,
      l2ChainId: cfg.l2.chainId,
      l2GenesisHash: cfg.l2.genesisHash,
      l1Hash: HASH,
      phase: "replica-confirmed",
    };
    const proven = document.createElement("div");
    renderProgressArticle(proven, record, record, cfg);
    expect(proven.querySelector('[data-step="confirmed"]')?.getAttribute("data-state")).toBe("done");
    const stored = document.createElement("div");
    renderProgressArticle(stored, record, null, cfg);
    expect(stored.querySelector('[data-step="confirmed"]')?.getAttribute("data-state")).toBe("pending");
    expect(stored.querySelector('[data-state="done"]')).toBeNull();
  });

  it("writes the submission into the account that approved it", async () => {
    const provider = createMockEip1193();
    let release: (value: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    await boot({ provider, accounts: [] });
    provider.handle("eth_sendTransaction", () => gate);
    await connectAndReview(provider);
    byId<HTMLButtonElement>("approve").click();
    await vi.waitFor(() => {
      expect(provider.calls("eth_sendTransaction")).toHaveLength(1);
    });
    provider.emit("accountsChanged", [OTHER]);
    await settle();
    release(HASH);
    await settle();
    expect(localStorage.getItem(journalKey(ACCOUNT)) ?? "").toContain(HASH);
    expect(localStorage.getItem(journalKey(OTHER)) ?? "").not.toContain(HASH);
  });

  it("refuses a recovery sent by a different account", async () => {
    const provider = createMockEip1193();
    const foreign = `0x${"cd".repeat(32)}`;
    await boot({
      provider,
      accounts: [ACCOUNT],
      rpc(method, params, url) {
        if (method === "eth_getTransactionByHash" && String(params[0]).toLowerCase() === foreign) {
          return {
            hash: foreign,
            from: OTHER,
            to: `0x${"11".repeat(20)}`,
            value: "0x0",
            input: "0x",
            nonce: "0x1",
          };
        }
        return defaultRpc(method, params, url);
      },
    });
    byId<HTMLInputElement>("recover-hash").value = foreign;
    byId<HTMLButtonElement>("recover").click();
    await settle();
    expect(text("history-status")).toBe("That deposit was sent by a different account.");
    expect(text("history-list")).not.toContain(foreign);
    expect(localStorage.getItem(journalKey(ACCOUNT)) ?? "").not.toContain(foreign);
  });

  it("drops history from the screen when the wallet account goes away", async () => {
    seedRecord(ACCOUNT, { l1Hash: HASH, phase: "l1-pending" });
    const provider = createMockEip1193();
    await boot({ provider, accounts: [ACCOUNT] });
    expect(text("history-list")).toContain(HASH);
    provider.emit("accountsChanged", []);
    await settle();
    expect(text("account")).toBe("Not connected");
    expect(text("history-list")).not.toContain(HASH);
    byId<HTMLButtonElement>("export-json").click();
    expect(text("history-status")).toBe("Connect a wallet before exporting history.");
    expect(localStorage.getItem(journalKey(ACCOUNT)) ?? "").toContain(HASH);
  });

  it("leaves reverted, cancelled, and replaced originals out of ETH transferred", () => {
    const row = (l1Hash: string, phase: DepositRecord["phase"], amountWei: string): DepositRecord => ({
      schemaVersion: 1,
      account: ACCOUNT,
      recipient: ACCOUNT,
      amountWei,
      configVersion: cfg.configVersion,
      l1ChainId: cfg.l1.chainId,
      l2ChainId: cfg.l2.chainId,
      l2GenesisHash: cfg.l2.genesisHash,
      l1Hash,
      phase,
    });
    const successor = `0x${"11".repeat(32)}`;
    const replaced = row(HASH, "replaced", "2000000000000000");
    replaced.replacedBy = successor;
    const next = row(successor, "l1-pending", "2000000000000000");
    next.replaces = HASH;
    const reverted = row(`0x${"22".repeat(32)}`, "l1-reverted", "1000000000000000");
    const cancelled = row(`0x${"33".repeat(32)}`, "cancelled", "1000000000000000");
    const confirmed = row(`0x${"44".repeat(32)}`, "replica-confirmed", "5000000000000000");
    const outage = row(`0x${"55".repeat(32)}`, "tracking-unavailable", "1000000000000000");
    expect(transferredPrincipalWei([replaced, next, reverted, cancelled, confirmed, outage])).toBe(
      2_000_000_000_000_000n + 5_000_000_000_000_000n + 1_000_000_000_000_000n,
    );
  });

  it("does not write an in-flight refresh into the account that was switched to", async () => {
    seedRecord(ACCOUNT, { l1Hash: HASH, phase: "l1-pending" });
    let releaseTx: (value: null) => void = () => {};
    const txGate = new Promise<null>((resolve) => {
      releaseTx = resolve;
    });
    const provider = createMockEip1193();
    await boot({
      provider,
      accounts: [ACCOUNT],
      rpc(method, params, url) {
        if (method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt") return txGate;
        return defaultRpc(method, params, url);
      },
    });
    expect(text("history-list")).toContain(HASH);
    provider.emit("accountsChanged", [OTHER]);
    await settle();
    releaseTx(null);
    await settle();
    expect(text("account")).toBe(OTHER);
    expect(text("history-list")).not.toContain(HASH);
    expect(localStorage.getItem(journalKey(OTHER)) ?? "").not.toContain(HASH);
    expect(localStorage.getItem(journalKey(ACCOUNT)) ?? "").toContain(HASH);
  });

  it("drops a late ForteL2 balance after the recipient is cleared", async () => {
    let releaseBalance: (value: string) => void = () => {};
    const balanceGate = new Promise<string>((resolve) => {
      releaseBalance = resolve;
    });
    let replicaBalances = 0;
    const provider = createMockEip1193();
    await boot({
      provider,
      accounts: [ACCOUNT],
      rpc(method, params, url) {
        if (method === "eth_getBalance" && !url.includes("tenderly")) {
          replicaBalances += 1;
          if (replicaBalances === 1) return balanceGate;
        }
        return defaultRpc(method, params, url);
      },
    });
    const recipient = byId<HTMLInputElement>("recipient");
    recipient.value = "";
    recipient.dispatchEvent(new Event("input", { bubbles: true }));
    provider.emit("accountsChanged", []);
    await settle();
    releaseBalance(hex(10n ** 21n));
    await settle();
    expect(text("account")).toBe("Not connected");
    expect(text("sepolia-balance")).toBe("–");
    expect(text("sepolia-balance-time")).toBe("–");
    expect(text("forte-balance")).toBe("–");
    expect(text("forte-balance")).not.toContain("1000");
  });

  it("does not keep a Sepolia balance after the wallet leaves Sepolia", async () => {
    const provider = createMockEip1193();
    await boot({ provider, accounts: [ACCOUNT] });
    expect(text("sepolia-balance")).toBe("1000 ETH");
    provider.handle("eth_chainId", () => "0x1");
    provider.emit("chainChanged", "0x1");
    await settle();
    expect(text("sepolia-balance")).toBe("–");
    expect(text("sepolia-balance-error")).toBe("Sepolia balance unavailable");
    expect(text("sepolia-balance")).not.toContain("1000");
  });

  it("does not call a submitted deposit included when tracking is down", () => {
    const record: DepositRecord = {
      schemaVersion: 1,
      account: ACCOUNT,
      recipient: ACCOUNT,
      amountWei: "2000000000000000",
      configVersion: cfg.configVersion,
      l1ChainId: cfg.l1.chainId,
      l2ChainId: cfg.l2.chainId,
      l2GenesisHash: cfg.l2.genesisHash,
      l1Hash: HASH,
      phase: "tracking-unavailable",
      lastProvenPhase: "l1-pending",
      lastCheckedAt: CREATED_AT,
    };
    const host = document.createElement("div");
    renderProgressArticle(host, record, record, cfg);
    expect(host.textContent).toContain(
      `Last confirmed: none at ${new Date(CREATED_AT).toISOString()}. Rechecking…`,
    );
    expect(host.textContent).not.toContain("Last confirmed: Included on Sepolia");
    expect(host.querySelector('[data-step="included"]')?.getAttribute("data-state")).toBe("pending");
  });

  it("downloads history without leaving the file link in the list", async () => {
    const provider = createMockEip1193();
    await boot({ provider, accounts: [ACCOUNT] });
    byId<HTMLButtonElement>("export-json").click();
    expect(byId("history-list").querySelector("a")).toBeNull();
    expect(document.querySelector("a[download]")).toBeNull();
    await settle();
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("renders lastError markup as text", async () => {
    seedRecord(ACCOUNT, {
      l1Hash: HASH,
      phase: "l1-pending",
    });
    const provider = createMockEip1193();
    await boot({
      provider,
      accounts: [ACCOUNT],
      rpc(method, params, url) {
        if (method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt") {
          throw new Error(IMG);
        }
        return defaultRpc(method, params, url);
      },
    });
    expect(document.querySelector("img")).toBeNull();
    expect(document.getElementById("progress-list")?.textContent).toContain(IMG);
    expect(document.getElementById("progress-list")?.querySelector("img")).toBeNull();
  });

  it("reviews and approves when the wallet rejects eth_maxPriorityFeePerGas", async () => {
    const provider = createMockEip1193();
    await boot({ provider, accounts: [] });
    provider.handle("eth_maxPriorityFeePerGas", () => {
      throw new Error('The method "eth_maxPriorityFeePerGas" does not exist / is not available.');
    });
    provider.handle("eth_feeHistory", () => ({
      reward: [["0x5"], ["0x1"], ["0x3"], ["0x9"], ["0x4"]],
    }));
    await connectAndReview(provider);
    expect(byId("review-panel").hidden).toBe(false);
    expect(text("review-fee")).toBe("0.000000000003 ETH");
    const feeLabel = byId("review-fee").previousElementSibling;
    expect(feeLabel?.textContent).toContain("Max network fee");
    expect(text("review-fee-source").trim()).toBe("from wallet fee history");
    expect(text("live")).toBe("Review the deposit, then approve in MetaMask.");
    byId<HTMLButtonElement>("approve").click();
    await settle();
    const sends = provider.calls("eth_sendTransaction");
    expect(sends).toHaveLength(1);
    const tx = (sends[0]?.params as { maxPriorityFeePerGas?: string }[])[0];
    expect(tx?.maxPriorityFeePerGas).toBe("0x4");
  });
});
