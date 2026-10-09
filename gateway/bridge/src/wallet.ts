/**
 * MetaMask discovery and Sepolia switching.
 * `connect` is the only accounts prompt, and it is for a user action.
 * 4001 and -32002 are terminal: they are never retried.
 */

const SEPOLIA_CHAIN_ID = "0xaa36a7";
const SEPOLIA_CHAIN_INT = 11155111n;
const DEFAULT_DISCOVERY_MS = 200;

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
};

export type InjectedProvider = Eip1193Provider & {
  isMetaMask?: boolean;
  isBraveWallet?: boolean;
  providers?: InjectedProvider[];
};

export type DiscoveryTarget = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
  ethereum?: InjectedProvider;
};

/** Injected so tests can end the announce window without waiting on the clock. */
export type DiscoveryTimer = {
  setTimeout(callback: () => void, ms: number): unknown;
};

export type DiscoverOptions = {
  windowMs?: number;
  timer?: DiscoveryTimer;
  target?: DiscoveryTarget;
};

export type WalletEvent = "accountsChanged" | "chainChanged" | "disconnect";

export type EnsureSepoliaResult =
  | { ok: true }
  | { ok: false; state: "user-rejected"; code: 4001 }
  | { ok: false; state: "request-pending"; code: -32002 }
  | { ok: false; state: "error"; code: number | null };

export type SepoliaAddConfig = {
  l1: { rpc: string };
};

export type Wallet = {
  /** Prompts for accounts. Call this only from a user action. */
  connect(): Promise<string[]>;
  /** Silent read of the already-connected accounts. */
  reconnect(): Promise<string[]>;
  ensureSepolia(cfg: SepoliaAddConfig): Promise<EnsureSepoliaResult>;
  on(event: WalletEvent, listener: (...args: unknown[]) => void): void;
  dispose(): void;
};

type Announcement = {
  rdns: string | null;
  provider: Eip1193Provider;
};

export function discoverMetaMask(options?: DiscoverOptions): Promise<Eip1193Provider | null> {
  const target = options?.target ?? defaultTarget();
  const timer = options?.timer ?? { setTimeout: globalThis.setTimeout.bind(globalThis) };
  const windowMs = discoveryWindow(options?.windowMs);
  const announced: Announcement[] = [];

  return new Promise((resolve) => {
    const onAnnounce = (event: Event): void => {
      const announcement = readAnnouncement(event);
      if (announcement) announced.push(announcement);
    };
    target.addEventListener("eip6963:announceProvider", onAnnounce);
    target.dispatchEvent(new Event("eip6963:requestProvider"));
    timer.setTimeout(() => {
      target.removeEventListener("eip6963:announceProvider", onAnnounce);
      const preferred = announced.find((item) => item.rdns === "io.metamask");
      resolve(preferred?.provider ?? legacyMetaMask(target));
    }, windowMs);
  });
}

export function createWallet(provider: Eip1193Provider): Wallet {
  const added: { event: WalletEvent; listener: (...args: unknown[]) => void }[] = [];

  return {
    connect(): Promise<string[]> {
      return readAccounts(provider, "eth_requestAccounts");
    },
    reconnect(): Promise<string[]> {
      return readAccounts(provider, "eth_accounts");
    },
    ensureSepolia(cfg: SepoliaAddConfig): Promise<EnsureSepoliaResult> {
      return ensureSepolia(provider, cfg);
    },
    on(event: WalletEvent, listener: (...args: unknown[]) => void): void {
      if (typeof provider.on !== "function") {
        throw new Error("provider does not support subscriptions");
      }
      provider.on(event, listener);
      added.push({ event, listener });
    },
    dispose(): void {
      for (const subscription of added) {
        removeProviderListener(provider, subscription.event, subscription.listener);
      }
      added.length = 0;
    },
  };
}

async function ensureSepolia(provider: Eip1193Provider, cfg: SepoliaAddConfig): Promise<EnsureSepoliaResult> {
  const current = await provider.request({ method: "eth_chainId", params: [] });
  if (isSepolia(current)) return { ok: true };

  const first = await switchToSepolia(provider);
  if (first.kind === "ok") return { ok: true };
  if (first.kind === "stop") return first.result;

  const added = await addSepolia(provider, cfg);
  if (added.kind === "stop") return added.result;

  const second = await switchToSepolia(provider);
  if (second.kind === "ok") return { ok: true };
  if (second.kind === "stop") return second.result;
  return { ok: false, state: "error", code: 4902 };
}

type SwitchOutcome =
  | { kind: "ok" }
  | { kind: "missing" }
  | { kind: "stop"; result: Exclude<EnsureSepoliaResult, { ok: true }> };

async function switchToSepolia(provider: Eip1193Provider): Promise<SwitchOutcome> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA_CHAIN_ID }],
    });
    return { kind: "ok" };
  } catch (err) {
    return classifySwitchError(err);
  }
}

async function addSepolia(
  provider: Eip1193Provider,
  cfg: SepoliaAddConfig,
): Promise<Exclude<SwitchOutcome, { kind: "missing" }>> {
  try {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: SEPOLIA_CHAIN_ID,
          chainName: "Sepolia",
          nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [cfg.l1.rpc],
          blockExplorerUrls: ["https://sepolia.etherscan.io"],
        },
      ],
    });
    return { kind: "ok" };
  } catch (err) {
    const classified = classifySwitchError(err);
    if (classified.kind === "missing") {
      return { kind: "stop", result: { ok: false, state: "error", code: 4902 } };
    }
    return classified;
  }
}

function classifySwitchError(err: unknown): SwitchOutcome {
  const code = errorCode(err);
  if (code === 4001) return { kind: "stop", result: { ok: false, state: "user-rejected", code: 4001 } };
  if (code === -32002) return { kind: "stop", result: { ok: false, state: "request-pending", code: -32002 } };
  if (code === 4902) return { kind: "missing" };
  return { kind: "stop", result: { ok: false, state: "error", code } };
}

function legacyMetaMask(target: DiscoveryTarget): Eip1193Provider | null {
  const ethereum = target.ethereum;
  if (!ethereum) return null;
  const listed = Array.isArray(ethereum.providers) ? ethereum.providers : [];
  const candidates = listed.length > 0 ? listed : [ethereum];
  for (const candidate of candidates) {
    if (isMetaMaskNotBrave(candidate)) return candidate;
  }
  return null;
}

function isMetaMaskNotBrave(provider: InjectedProvider | undefined): provider is InjectedProvider {
  return !!provider && provider.isMetaMask === true && provider.isBraveWallet !== true;
}

function readAnnouncement(event: Event): Announcement | null {
  if (!("detail" in event)) return null;
  const detail = (event as CustomEvent<unknown>).detail;
  if (detail === null || typeof detail !== "object") return null;
  const info = (detail as { info?: unknown }).info;
  const provider = (detail as { provider?: unknown }).provider;
  if (provider === null || typeof provider !== "object" || typeof (provider as Eip1193Provider).request !== "function") {
    return null;
  }
  const rdns = info !== null && typeof info === "object" ? (info as { rdns?: unknown }).rdns : undefined;
  return {
    rdns: typeof rdns === "string" ? rdns : null,
    provider: provider as Eip1193Provider,
  };
}

async function readAccounts(provider: Eip1193Provider, method: "eth_requestAccounts" | "eth_accounts"): Promise<string[]> {
  const result = await provider.request({ method, params: [] });
  if (!Array.isArray(result) || result.some((item) => typeof item !== "string")) {
    throw new Error(`${method} returned an unexpected payload`);
  }
  return result;
}

function removeProviderListener(
  provider: Eip1193Provider,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  if (typeof provider.removeListener === "function") {
    provider.removeListener(event, listener);
    return;
  }
  if (typeof provider.off === "function") provider.off(event, listener);
}

function isSepolia(value: unknown): boolean {
  const parsed = parseChainId(value);
  return parsed === SEPOLIA_CHAIN_INT;
}

function parseChainId(value: unknown): bigint | null {
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function errorCode(err: unknown): number | null {
  if (err === null || typeof err !== "object" || !("code" in err)) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "number" && Number.isInteger(code)) return code;
  return null;
}

function discoveryWindow(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return DEFAULT_DISCOVERY_MS;
}

function defaultTarget(): DiscoveryTarget {
  const root = globalThis as { window?: DiscoveryTarget };
  return root.window ?? (globalThis as unknown as DiscoveryTarget);
}
