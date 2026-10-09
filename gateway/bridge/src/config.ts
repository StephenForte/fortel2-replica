/**
 * Loads `/bridge-config.json` and checks the live chains still match it.
 * A mismatch and an outage both fail closed. An outage is not a mismatch.
 */

import type { RpcClient } from "./rpc";
import type { BridgeConfig } from "./types";

const SYSTEM_CONFIG_SELECTOR = "0x33d7e2bd";
const SEPOLIA_CHAIN_ID = "0xaa36a7";
const FORTE_CHAIN_ID = "0x354";

const ROOT_KEYS = ["configVersion", "l1", "l2", "contracts", "deposit"] as const;
const L1_KEYS = ["chainId", "chainIdHex", "name", "rpc", "explorerTx"] as const;
const L2_KEYS = ["chainId", "chainIdHex", "name", "genesisHash", "sequencerRpc", "replicaRpc", "explorerTx"] as const;
const CONTRACT_KEYS = ["optimismPortal", "systemConfig", "metamaskDelegationManager"] as const;
const DEPOSIT_KEYS = [
  "l2GasLimit",
  "capWei",
  "presetsWei",
  "defaultWei",
  "quoteTtlSeconds",
  "l1GasFloor",
  "l1GasCeiling",
  "l1GasMultiplier",
  "pollSeconds",
] as const;

export type ConfigFetch = (url: string) => Promise<Pick<Response, "ok" | "text">>;

export type WalletChainReader = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
};

export type LoadConfigResult =
  | { ok: true; config: BridgeConfig }
  | { ok: false; phase: "configuration-mismatch"; reason: string }
  | { ok: false; unavailable: true };

export type VerifyConfigResult =
  | { ok: true }
  | { ok: false; phase: "configuration-mismatch"; reason: string }
  | { ok: false; unavailable: true };

export async function loadConfig(doFetch: ConfigFetch): Promise<LoadConfigResult> {
  let response: Pick<Response, "ok" | "text">;
  try {
    response = await doFetch("/bridge-config.json");
  } catch {
    return { ok: false, unavailable: true };
  }
  if (!response.ok) return { ok: false, unavailable: true };

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, unavailable: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, phase: "configuration-mismatch", reason: "bridge-config.json is not JSON" };
  }

  const reason = validateConfig(parsed);
  if (reason !== null) return { ok: false, phase: "configuration-mismatch", reason };
  return { ok: true, config: parsed as BridgeConfig };
}

export async function verifyConfig(input: {
  cfg: BridgeConfig;
  l1: RpcClient;
  sequencer: RpcClient;
  replica: RpcClient;
  wallet: WalletChainReader;
}): Promise<VerifyConfigResult> {
  try {
    return await verifyConfigBody(input);
  } catch {
    return { ok: false, unavailable: true };
  }
}

async function verifyConfigBody(input: {
  cfg: BridgeConfig;
  l1: RpcClient;
  sequencer: RpcClient;
  replica: RpcClient;
  wallet: WalletChainReader;
}): Promise<VerifyConfigResult> {
  const walletChain = await input.wallet.request({ method: "eth_chainId", params: [] });
  if (!sameChain(walletChain, SEPOLIA_CHAIN_ID)) {
    return mismatch(`wallet chain is ${preview(walletChain)}, expected ${SEPOLIA_CHAIN_ID}`);
  }

  const l1Chain = await input.l1.call("eth_chainId", []);
  if (!sameChain(l1Chain, input.cfg.l1.chainIdHex)) {
    return mismatch(`L1 chain is ${preview(l1Chain)}, expected ${input.cfg.l1.chainIdHex}`);
  }

  const code = await input.l1.call("eth_getCode", [input.cfg.contracts.optimismPortal, "latest"]);
  if (!hasBytecode(code)) {
    return mismatch("OptimismPortal has no code");
  }

  const reported = await input.l1.call("eth_call", [
    { to: input.cfg.contracts.optimismPortal, data: SYSTEM_CONFIG_SELECTOR },
    "latest",
  ]);
  const systemConfig = decodeAddressWord(reported);
  if (systemConfig === null || systemConfig.toLowerCase() !== input.cfg.contracts.systemConfig.toLowerCase()) {
    return mismatch(
      `portal systemConfig is ${systemConfig ?? "unreadable"}, expected ${input.cfg.contracts.systemConfig}`,
    );
  }

  const sequencer = await verifyL2(input.sequencer, input.cfg, "sequencer");
  if (!sequencer.ok) return sequencer;
  return verifyL2(input.replica, input.cfg, "replica");
}

async function verifyL2(client: RpcClient, cfg: BridgeConfig, label: "sequencer" | "replica"): Promise<VerifyConfigResult> {
  const chain = await client.call("eth_chainId", []);
  if (!sameChain(chain, FORTE_CHAIN_ID) || !sameChain(chain, cfg.l2.chainIdHex)) {
    return mismatch(`${label} chain is ${preview(chain)}, expected ${FORTE_CHAIN_ID}`);
  }
  const block = await client.call("eth_getBlockByNumber", ["0x0", false]);
  const hash = blockHash(block);
  if (hash === null || hash.toLowerCase() !== cfg.l2.genesisHash.toLowerCase()) {
    return mismatch(`${label} genesis is ${hash ?? "missing"}, expected ${cfg.l2.genesisHash}`);
  }
  return { ok: true };
}

function validateConfig(value: unknown): string | null {
  if (!isObject(value)) return "bridge-config.json is not an object";
  const root = exactKeys(value, ROOT_KEYS);
  if (root) return root;

  if (typeof value.configVersion !== "string" || value.configVersion.length === 0) {
    return "configVersion is missing";
  }

  const l1Reason = validateChainSide(value.l1, L1_KEYS, "l1");
  if (l1Reason) return l1Reason;
  const l2Reason = validateChainSide(value.l2, L2_KEYS, "l2");
  if (l2Reason) return l2Reason;
  const l2 = value.l2 as Record<string, unknown>;
  if (!isBytes32(l2.genesisHash)) return "l2.genesisHash is not a 32-byte hex string";
  if (!isNonEmptyString(l2.sequencerRpc)) return "l2.sequencerRpc is missing";
  if (!isNonEmptyString(l2.replicaRpc)) return "l2.replicaRpc is missing";

  if (!isObject(value.contracts)) return "contracts is not an object";
  const contractKeys = exactKeys(value.contracts, CONTRACT_KEYS);
  if (contractKeys) return contractKeys;
  const contracts = value.contracts;
  if (!isAddress(contracts.optimismPortal)) return "contracts.optimismPortal is not an address";
  if (!isAddress(contracts.systemConfig)) return "contracts.systemConfig is not an address";
  if (!isAddress(contracts.metamaskDelegationManager)) return "contracts.metamaskDelegationManager is not an address";

  return validateDeposit(value.deposit);
}

function validateChainSide(value: unknown, keys: readonly string[], label: string): string | null {
  if (!isObject(value)) return `${label} is not an object`;
  const keyError = exactKeys(value, keys);
  if (keyError) return `${label}: ${keyError}`;
  if (!isPositiveInt(value.chainId)) return `${label}.chainId is not an integer`;
  if (!isHexQuantity(value.chainIdHex) || BigInt(value.chainIdHex) !== BigInt(value.chainId)) {
    return `${label}.chainIdHex does not match chainId`;
  }
  if (!isNonEmptyString(value.name)) return `${label}.name is missing`;
  if (label === "l1" && !isNonEmptyString(value.rpc)) return `${label}.rpc is missing`;
  if (!isNonEmptyString(value.explorerTx)) return `${label}.explorerTx is missing`;
  return null;
}

function validateDeposit(value: unknown): string | null {
  if (!isObject(value)) return "deposit is not an object";
  const keyError = exactKeys(value, DEPOSIT_KEYS);
  if (keyError) return `deposit: ${keyError}`;
  if (!isWei(value.l2GasLimit)) return "deposit.l2GasLimit is not a decimal wei string";
  if (!isWei(value.capWei)) return "deposit.capWei is not a decimal wei string";
  if (!isWei(value.defaultWei)) return "deposit.defaultWei is not a decimal wei string";
  if (!isWei(value.l1GasFloor)) return "deposit.l1GasFloor is not a decimal wei string";
  if (!isWei(value.l1GasCeiling)) return "deposit.l1GasCeiling is not a decimal wei string";
  if (!Array.isArray(value.presetsWei) || value.presetsWei.some((item) => !isWei(item))) {
    return "deposit.presetsWei is not a list of decimal wei strings";
  }
  if (!isNonNegativeInt(value.quoteTtlSeconds)) return "deposit.quoteTtlSeconds is not an integer";
  if (!isNonNegativeInt(value.pollSeconds)) return "deposit.pollSeconds is not an integer";
  if (typeof value.l1GasMultiplier !== "number" || !Number.isSafeInteger(value.l1GasMultiplier) || value.l1GasMultiplier < 1) {
    return "deposit.l1GasMultiplier is not a positive integer";
  }
  return null;
}

function mismatch(reason: string): VerifyConfigResult {
  return { ok: false, phase: "configuration-mismatch", reason };
}

function hasBytecode(code: unknown): boolean {
  if (typeof code !== "string" || !/^0x[0-9a-fA-F]*$/.test(code) || code.length % 2 !== 0) return false;
  return code.length > 2;
}

function decodeAddressWord(word: unknown): string | null {
  if (typeof word !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(word)) return null;
  const body = word.slice(2).toLowerCase();
  if (!body.startsWith("000000000000000000000000")) return null;
  return `0x${body.slice(24)}`;
}

function blockHash(block: unknown): string | null {
  if (block === null || typeof block !== "object") return null;
  const hash = (block as { hash?: unknown }).hash;
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  return hash;
}

function sameChain(value: unknown, expectedHex: string): boolean {
  const got = parseChain(value);
  const expected = parseChain(expectedHex);
  if (got === null || expected === null) return false;
  return got === expected;
}

function parseChain(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  return null;
}

function preview(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 66);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "unreadable";
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): string | null {
  const actual = Object.keys(value);
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = actual.filter((key) => !keys.includes(key));
  if (missing.length > 0) return `missing ${missing.join(", ")}`;
  if (extra.length > 0) return `unexpected ${extra.join(", ")}`;
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isBytes32(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isHexQuantity(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
}

function isWei(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
