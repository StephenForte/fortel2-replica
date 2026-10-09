import { afterEach, describe, expect, it } from "vitest";

import { createWallet, discoverMetaMask, type DiscoveryTarget } from "../src/wallet";
import { createMockEip1193, type MockEip1193 } from "./mock-eip1193";

const RPC = "https://example.invalid/sepolia";

function timer() {
  let fire: (() => void) | undefined;
  let ms = -1;
  return {
    clock: {
      setTimeout(callback: () => void, windowMs: number) {
        ms = windowMs;
        fire = callback;
        return 1;
      },
    },
    ms: () => ms,
    flush(): void {
      if (!fire) throw new Error("discovery timer was not armed");
      fire();
    },
  };
}

function announce(rdns: string, provider: MockEip1193): void {
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: { info: { rdns, uuid: rdns, name: rdns, icon: "" }, provider },
    }),
  );
}

function walletError(code: number): Error {
  return Object.assign(new Error(`wallet ${code}`), { code });
}

afterEach(() => {
  delete (window as DiscoveryTarget).ethereum;
});

describe("discoverMetaMask", () => {
  it("chooses MetaMask when MetaMask and Brave both announce", async () => {
    const brave = createMockEip1193({ isMetaMask: true, isBraveWallet: true });
    const metamask = createMockEip1193({ isMetaMask: true, isBraveWallet: false });
    const clock = timer();
    const onRequest = (): void => {
      announce("com.brave.wallet", brave);
      announce("io.metamask", metamask);
    };
    window.addEventListener("eip6963:requestProvider", onRequest);
    try {
      const pending = discoverMetaMask({ timer: clock.clock, target: window });
      expect(clock.ms()).toBe(200);
      clock.flush();
      await expect(pending).resolves.toBe(metamask);
    } finally {
      window.removeEventListener("eip6963:requestProvider", onRequest);
    }
  });

  it("returns null when Brave is the only wallet", async () => {
    const brave = createMockEip1193({ isMetaMask: true, isBraveWallet: true });
    (window as DiscoveryTarget).ethereum = brave;
    const clock = timer();
    const onRequest = (): void => {
      announce("com.brave.wallet", brave);
    };
    window.addEventListener("eip6963:requestProvider", onRequest);
    try {
      const pending = discoverMetaMask({ timer: clock.clock, target: window });
      clock.flush();
      await expect(pending).resolves.toBeNull();
    } finally {
      window.removeEventListener("eip6963:requestProvider", onRequest);
    }
  });

  it("uses the legacy providers list when nothing announces", async () => {
    const brave = createMockEip1193({ isMetaMask: true, isBraveWallet: true });
    const metamask = createMockEip1193({ isMetaMask: true, isBraveWallet: false });
    (window as DiscoveryTarget).ethereum = {
      isMetaMask: true,
      isBraveWallet: true,
      providers: [brave, metamask],
      request: brave.request.bind(brave),
    };
    const clock = timer();
    const pending = discoverMetaMask({ timer: clock.clock, target: window });
    clock.flush();
    await expect(pending).resolves.toBe(metamask);
  });
});

describe("createWallet", () => {
  it("prompts with eth_requestAccounts and reconnects with eth_accounts", async () => {
    const mock = createMockEip1193();
    mock.handle("eth_requestAccounts", () => ["0xabc"]);
    mock.handle("eth_accounts", () => ["0xabc"]);
    const wallet = createWallet(mock);
    await expect(wallet.connect()).resolves.toEqual(["0xabc"]);
    await expect(wallet.reconnect()).resolves.toEqual(["0xabc"]);
    expect(mock.calls("eth_requestAccounts")).toHaveLength(1);
    expect(mock.calls("eth_accounts")).toHaveLength(1);
  });

  it("adds Sepolia and switches again after 4902", async () => {
    const mock = createMockEip1193();
    mock.handle("eth_chainId", () => "0x1");
    mock.handle("wallet_switchEthereumChain", (_params, callIndex) => {
      if (callIndex === 1) throw walletError(4902);
      return null;
    });
    mock.handle("wallet_addEthereumChain", () => null);
    const wallet = createWallet(mock);

    await expect(wallet.ensureSepolia({ l1: { rpc: RPC } })).resolves.toEqual({ ok: true });

    expect(mock.requests.map((entry) => entry.method)).toEqual([
      "eth_chainId",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ]);
    expect(mock.calls("wallet_addEthereumChain")[0]?.params).toEqual([
      {
        chainId: "0xaa36a7",
        chainName: "Sepolia",
        nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [RPC],
        blockExplorerUrls: ["https://sepolia.etherscan.io"],
      },
    ]);
    expect(mock.calls("wallet_switchEthereumChain")[0]?.params).toEqual([{ chainId: "0xaa36a7" }]);
  });

  it("does not loop when the follow-up switch is also 4902", async () => {
    const mock = createMockEip1193();
    mock.handle("eth_chainId", () => "0x1");
    mock.handle("wallet_switchEthereumChain", () => {
      throw walletError(4902);
    });
    mock.handle("wallet_addEthereumChain", () => null);
    const wallet = createWallet(mock);

    await expect(wallet.ensureSepolia({ l1: { rpc: RPC } })).resolves.toEqual({
      ok: false,
      state: "error",
      code: 4902,
    });
    expect(mock.calls("wallet_switchEthereumChain")).toHaveLength(2);
    expect(mock.calls("wallet_addEthereumChain")).toHaveLength(1);
  });

  it.each([
    [4001, "user-rejected"],
    [-32002, "request-pending"],
  ] as const)("treats %s as terminal and issues one wallet request", async (code, state) => {
    const mock = createMockEip1193();
    mock.handle("eth_chainId", () => "0x1");
    mock.handle("wallet_switchEthereumChain", () => {
      throw walletError(code);
    });
    mock.handle("wallet_addEthereumChain", () => {
      throw new Error("add must not run");
    });
    const wallet = createWallet(mock);

    await expect(wallet.ensureSepolia({ l1: { rpc: RPC } })).resolves.toEqual({
      ok: false,
      state,
      code,
    });
    expect(mock.calls("wallet_switchEthereumChain")).toHaveLength(1);
    expect(mock.calls("wallet_addEthereumChain")).toHaveLength(0);
    expect(mock.requests.filter((entry) => entry.method.startsWith("wallet_"))).toHaveLength(1);
  });

  it("does not switch again when adding the chain is rejected", async () => {
    const mock = createMockEip1193();
    mock.handle("eth_chainId", () => "0x1");
    mock.handle("wallet_switchEthereumChain", () => {
      throw walletError(4902);
    });
    mock.handle("wallet_addEthereumChain", () => {
      throw walletError(4001);
    });
    const wallet = createWallet(mock);

    await expect(wallet.ensureSepolia({ l1: { rpc: RPC } })).resolves.toEqual({
      ok: false,
      state: "user-rejected",
      code: 4001,
    });
    expect(mock.calls("wallet_switchEthereumChain")).toHaveLength(1);
    expect(mock.calls("wallet_addEthereumChain")).toHaveLength(1);
  });

  it("dispose removes every listener it added", () => {
    const mock = createMockEip1193();
    const wallet = createWallet(mock);
    let hits = 0;
    wallet.on("accountsChanged", () => {
      hits += 1;
    });
    wallet.on("chainChanged", () => {
      hits += 1;
    });
    wallet.on("disconnect", () => {
      hits += 1;
    });
    expect(mock.listenerCount()).toBe(3);

    wallet.dispose();
    mock.emit("accountsChanged", []);
    mock.emit("chainChanged", "0x1");
    mock.emit("disconnect", {});

    expect(mock.listenerCount()).toBe(0);
    expect(hits).toBe(0);
  });
});
