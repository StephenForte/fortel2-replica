/**
 * Builds a frozen deposit quote. Wei math is bigint only.
 * The L1 gas limit is never lowered to the 100000 L2 argument.
 */

import { encodeDepositCall, parseEthAmount, validateRecipient } from "./bridge-protocol";
import type { RpcClient } from "./rpc";
import type { BridgeConfig, DepositQuote } from "./types";
import type { Eip1193Provider } from "./wallet";

const L2_GAS = 100_000n;
/** Brief rule: maxFeePerGas = 2 * baseFee + maxPriorityFeePerGas. */
const FEE_BASE_MULTIPLIER = 2n;
const DELEGATION_CODE = /^0xef0100[0-9a-fA-F]{40}$/i;

export type QuoteInput = {
  amount: string;
  recipient: string;
  account: string;
};

export type QuoteContext = {
  account: string;
  chainId: string | number;
  recipient: string;
  amountWei: string;
  configVersion: string;
};

export type FeeSource = "wallet" | "wallet-feeHistory" | "l1";

/** DepositQuote plus which priority-fee read succeeded. Legacy quotes omit it. */
export type QuotedDeposit = DepositQuote & {
  feeSource?: FeeSource;
};

export type QuoteDeps = {
  cfg: BridgeConfig;
  replica: RpcClient;
  sequencer: RpcClient;
  wallet: Eip1193Provider;
  l1: RpcClient;
  now: () => number;
};

export class QuoteError extends Error {
  readonly unavailable: boolean;

  constructor(message: string, options?: { unavailable?: boolean }) {
    super(message);
    this.name = "QuoteError";
    this.unavailable = options?.unavailable === true;
  }
}

type FeeQuote =
  | {
      kind: "eip1559";
      perGas: bigint;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      feeSource: FeeSource;
    }
  | { kind: "legacy"; perGas: bigint; gasPrice: bigint };

const FEE_HISTORY_BLOCKS = 5;
const FEE_HISTORY_PARAMS = ["0x5", "latest", [50]] as const;

export async function createQuote(input: QuoteInput, deps: QuoteDeps): Promise<QuotedDeposit> {
  const amountWei = parseEthAmount(input.amount, parseWei(deps.cfg.deposit.capWei, "cap"));
  const recipient = validateRecipient(input.recipient);
  const account = requireAccount(input.account);

  await confirmRecipientCode(deps, recipient, account);

  if (deps.cfg.deposit.l2GasLimit !== decimal(L2_GAS)) {
    throw new QuoteError("L2 gas limit must stay 100000");
  }
  const data = encodeDepositCall(recipient, amountWei, L2_GAS);
  const portal = deps.cfg.contracts.optimismPortal;
  const estimate = await estimateGas(deps.wallet, {
    from: account,
    to: portal,
    value: hexQuantity(amountWei),
    data,
  });
  const limit = l1GasLimit(estimate, deps.cfg);
  const fees = await readFees(deps.wallet, deps.l1);
  const maxNetworkFeeWei = limit * fees.perGas;
  const maxWalletDebitWei = amountWei + maxNetworkFeeWei;
  const balance = await walletBalance(deps.wallet, account);
  if (balance < maxWalletDebitWei) {
    throw new QuoteError("insufficient balance");
  }

  const createdAt = readNow(deps.now);
  const expiresAt = createdAt + ttlMillis(deps.cfg.deposit.quoteTtlSeconds);
  if (!Number.isSafeInteger(expiresAt)) throw new QuoteError("quote expiry is unusable");

  const base = {
    account,
    recipient,
    amountWei: decimal(amountWei),
    configVersion: deps.cfg.configVersion,
    l1ChainId: deps.cfg.l1.chainId,
    l2ChainId: deps.cfg.l2.chainId,
    l2GenesisHash: deps.cfg.l2.genesisHash,
    createdAt,
    expiresAt,
    portal,
    data,
    l2GasLimit: decimal(L2_GAS),
    l1GasEstimate: decimal(estimate),
    l1GasLimit: decimal(limit),
    maxNetworkFeeWei: decimal(maxNetworkFeeWei),
    maxWalletDebitWei: decimal(maxWalletDebitWei),
  };

  const quote: QuotedDeposit =
    fees.kind === "eip1559"
      ? {
          ...base,
          maxFeePerGasWei: decimal(fees.maxFeePerGas),
          maxPriorityFeePerGasWei: decimal(fees.maxPriorityFeePerGas),
          feeSource: fees.feeSource,
        }
      : {
          ...base,
          gasPriceWei: decimal(fees.gasPrice),
        };
  return Object.freeze(quote);
}

export function isQuoteValid(quote: DepositQuote, ctx: QuoteContext, now: number): boolean {
  if (!Number.isSafeInteger(now) || now >= quote.expiresAt) return false;
  if (!sameAddress(quote.account, ctx.account)) return false;
  if (!sameChain(quote.l1ChainId, ctx.chainId)) return false;
  if (!sameAddress(quote.recipient, ctx.recipient)) return false;
  if (quote.amountWei !== ctx.amountWei) return false;
  if (quote.configVersion !== ctx.configVersion) return false;
  return true;
}

function l1GasLimit(estimate: bigint, cfg: BridgeConfig): bigint {
  const multiplier = positiveInt(cfg.deposit.l1GasMultiplier, "L1 gas multiplier");
  const floor = parseWei(cfg.deposit.l1GasFloor, "L1 gas floor");
  const ceiling = parseWei(cfg.deposit.l1GasCeiling, "L1 gas ceiling");
  const scaled = estimate * multiplier;
  const limit = scaled > floor ? scaled : floor;
  if (limit > ceiling) {
    throw new QuoteError(`L1 gas limit ${decimal(limit)} exceeds the ceiling of ${decimal(ceiling)}`);
  }
  return limit;
}

async function recipientCode(replica: RpcClient, recipient: string): Promise<string> {
  let code: unknown;
  try {
    code = await replica.call("eth_getCode", [recipient, "latest"]);
  } catch {
    throw new QuoteError("recipient code unavailable", { unavailable: true });
  }
  if (typeof code !== "string" || !/^0x[0-9a-fA-F]*$/.test(code) || code.length % 2 !== 0) {
    throw new QuoteError("recipient code is unreadable");
  }
  return code;
}

export async function confirmRecipientCode(
  clients: { replica: RpcClient; sequencer: RpcClient },
  recipient: string,
  account: string,
): Promise<void> {
  const replicaCode = await recipientCode(clients.replica, recipient);
  const sequencerCode = await recipientCode(clients.sequencer, recipient);
  assertRecipientCode(replicaCode, sequencerCode, recipient, account);
}

function assertRecipientCode(replicaCode: string, sequencerCode: string, recipient: string, account: string): void {
  if (replicaCode.toLowerCase() !== sequencerCode.toLowerCase()) {
    throw new QuoteError("recipient code differs between sequencer and replica");
  }
  const code = replicaCode;
  if (code.toLowerCase() === "0x") return;
  if (DELEGATION_CODE.test(code)) {
    if (recipient.toLowerCase() !== account.toLowerCase()) {
      throw new QuoteError("EIP-7702 recipient is not the connected account");
    }
    return;
  }
  throw new QuoteError("recipient is a contract");
}

async function estimateGas(wallet: Eip1193Provider, tx: Record<string, string>): Promise<bigint> {
  let raw: unknown;
  try {
    raw = await wallet.request({ method: "eth_estimateGas", params: [tx] });
  } catch {
    throw new QuoteError("gas estimate unavailable", { unavailable: true });
  }
  return parseHexQuantity(raw, "gas estimate");
}

async function readFees(wallet: Eip1193Provider, l1: RpcClient): Promise<FeeQuote> {
  let block: unknown;
  try {
    block = await wallet.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
  } catch {
    throw new QuoteError("fee data unavailable", { unavailable: true });
  }
  if (block === null || typeof block !== "object") {
    throw new QuoteError("fee data unavailable", { unavailable: true });
  }
  const baseFeePerGas = (block as { baseFeePerGas?: unknown }).baseFeePerGas;
  if (baseFeePerGas === undefined || baseFeePerGas === null) {
    const gasPrice = await requestQuantity(wallet, "eth_gasPrice");
    return { kind: "legacy", perGas: gasPrice, gasPrice };
  }
  const baseFee = parseHexQuantity(baseFeePerGas, "baseFeePerGas");
  const priority = await readPriorityFee(wallet, l1);
  const maxFeePerGas = baseFee * FEE_BASE_MULTIPLIER + priority.value;
  return {
    kind: "eip1559",
    perGas: maxFeePerGas,
    maxFeePerGas,
    maxPriorityFeePerGas: priority.value,
    feeSource: priority.source,
  };
}

async function readPriorityFee(
  wallet: Eip1193Provider,
  l1: RpcClient,
): Promise<{ value: bigint; source: FeeSource }> {
  const fromWallet = await tryWalletPriority(wallet);
  if (fromWallet !== null) return { value: fromWallet, source: "wallet" };
  const fromHistory = await tryWalletFeeHistory(wallet);
  if (fromHistory !== null) return { value: fromHistory, source: "wallet-feeHistory" };
  const fromL1 = await tryL1Priority(l1);
  if (fromL1 !== null) return { value: fromL1, source: "l1" };
  throw new QuoteError("priority fee unavailable", { unavailable: true });
}

async function tryWalletPriority(wallet: Eip1193Provider): Promise<bigint | null> {
  try {
    const raw = await wallet.request({ method: "eth_maxPriorityFeePerGas", params: [] });
    return tryHexQuantity(raw);
  } catch {
    return null;
  }
}

async function tryWalletFeeHistory(wallet: Eip1193Provider): Promise<bigint | null> {
  try {
    const raw = await wallet.request({ method: "eth_feeHistory", params: [...FEE_HISTORY_PARAMS] });
    return medianFeeHistoryReward(raw);
  } catch {
    return null;
  }
}

async function tryL1Priority(l1: RpcClient): Promise<bigint | null> {
  try {
    const raw = await l1.call("eth_maxPriorityFeePerGas", []);
    return tryHexQuantity(raw);
  } catch {
    return null;
  }
}

function medianFeeHistoryReward(raw: unknown): bigint | null {
  if (raw === null || typeof raw !== "object") return null;
  const reward = (raw as { reward?: unknown }).reward;
  if (!Array.isArray(reward) || reward.length !== FEE_HISTORY_BLOCKS) return null;
  const values: bigint[] = [];
  for (const block of reward) {
    if (!Array.isArray(block) || block.length < 1) return null;
    const value = tryHexQuantity(block[0]);
    if (value === null) return null;
    values.push(value);
  }
  values.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return values[2] ?? null;
}

async function requestQuantity(wallet: Eip1193Provider, method: string): Promise<bigint> {
  let raw: unknown;
  try {
    raw = await wallet.request({ method, params: [] });
  } catch {
    throw new QuoteError(`${method} unavailable`, { unavailable: true });
  }
  return parseHexQuantity(raw, method);
}

async function walletBalance(wallet: Eip1193Provider, account: string): Promise<bigint> {
  let raw: unknown;
  try {
    raw = await wallet.request({ method: "eth_getBalance", params: [account, "latest"] });
  } catch {
    throw new QuoteError("balance unavailable", { unavailable: true });
  }
  return parseHexQuantity(raw, "balance");
}

function requireAccount(account: string): string {
  try {
    return validateRecipient(account);
  } catch (err) {
    const message = err instanceof Error ? err.message : "account: malformed";
    throw new QuoteError(message.replace(/^recipient:/, "account:"));
  }
}

function readNow(now: () => number): number {
  const createdAt = now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new QuoteError("clock is unusable");
  return createdAt;
}

function ttlMillis(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new QuoteError("quote TTL is unusable");
  const millis = seconds * 1000;
  if (!Number.isSafeInteger(millis)) throw new QuoteError("quote TTL is unusable");
  return millis;
}

function positiveInt(value: number, label: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new QuoteError(`${label} is unusable`);
  }
  return BigInt(value);
}

function parseWei(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new QuoteError(`${label} is unusable`);
  return BigInt(value);
}

function parseHexQuantity(value: unknown, label: string): bigint {
  const parsed = tryHexQuantity(value);
  if (parsed === null) throw new QuoteError(`${label} is unreadable`);
  return parsed;
}

function tryHexQuantity(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  return BigInt(value);
}

function hexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function decimal(value: bigint): string {
  return value.toString(10);
}

function sameAddress(left: string, right: string): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(left) || !/^0x[0-9a-fA-F]{40}$/.test(right)) return false;
  return left.toLowerCase() === right.toLowerCase();
}

function sameChain(left: string | number, right: string | number): boolean {
  const a = parseChain(left);
  const b = parseChain(right);
  return a !== null && b !== null && a === b;
}

function parseChain(value: string | number): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  return null;
}
