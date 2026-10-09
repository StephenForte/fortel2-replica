/**
 * Submits the frozen quote. One eth_sendTransaction per user approval.
 * The transaction is copied from the quote after a fresh preflight.
 * Nothing here resubmits.
 */

import { verifyConfig } from "./config";
import { confirmRecipientCode, isQuoteValid, QuoteError, type QuoteContext } from "./quote";
import type { RpcClient } from "./rpc";
import type { BridgeConfig, DepositQuote, DepositRecord } from "./types";
import type { Eip1193Provider } from "./wallet";

const HASH_RE = /^0x[0-9a-f]{64}$/i;
const UNCERTAIN_GUIDANCE =
  "Check MetaMask activity. If a deposit transaction is there, paste the hash before trying again.";

const inFlight = new WeakSet<object>();

export class DepositInFlightError extends Error {
  constructor() {
    super("a deposit submission is already in progress");
    this.name = "DepositInFlightError";
  }
}

export type SubmitResult =
  | { kind: "submitted"; record: DepositRecord }
  | { kind: "wallet-rejected" }
  | { kind: "uncertain"; guidance: string }
  | { kind: "blocked"; reason: string };

export type SubmitDeps = {
  provider: Eip1193Provider;
  cfg: BridgeConfig;
  l1: RpcClient;
  sequencer: RpcClient;
  replica: RpcClient;
  now: () => number;
  ctx: QuoteContext;
  onHash: (record: DepositRecord) => Promise<void> | void;
};

export async function submitDeposit(quote: DepositQuote, deps: SubmitDeps): Promise<SubmitResult> {
  const provider = deps.provider;
  if (inFlight.has(provider)) throw new DepositInFlightError();
  inFlight.add(provider);
  try {
    return await submitOnce(quote, deps);
  } finally {
    inFlight.delete(provider);
  }
}

async function submitOnce(quote: DepositQuote, deps: SubmitDeps): Promise<SubmitResult> {
  if (!isQuoteValid(quote, deps.ctx, deps.now())) {
    return { kind: "blocked", reason: "quote is no longer valid" };
  }

  const verified = await verifyConfig({
    cfg: deps.cfg,
    l1: deps.l1,
    sequencer: deps.sequencer,
    replica: deps.replica,
    wallet: deps.provider,
  });
  if (!verified.ok) {
    if ("unavailable" in verified) return { kind: "blocked", reason: "configuration check unavailable" };
    return { kind: "blocked", reason: verified.reason };
  }

  const balance = await readBalance(deps.provider, quote.account);
  if (balance === null) return { kind: "blocked", reason: "balance check failed" };
  let debit: bigint;
  try {
    debit = BigInt(quote.maxWalletDebitWei);
  } catch {
    return { kind: "blocked", reason: "quote is not payable" };
  }
  if (balance < debit) return { kind: "blocked", reason: "insufficient balance" };
  if (!isQuoteValid(quote, deps.ctx, deps.now())) {
    return { kind: "blocked", reason: "quote is no longer valid" };
  }

  const tx = transactionFromQuote(quote);
  if (tx === null) return { kind: "blocked", reason: "quote cannot be encoded" };
  const recipientNow = await recheckRecipient(deps, quote);
  if (recipientNow !== null) return recipientNow;
  const walletNow = await readWalletNow(deps.provider, quote);
  if (walletNow !== null) return walletNow;

  let raw: unknown;
  try {
    raw = await deps.provider.request({ method: "eth_sendTransaction", params: [tx] });
  } catch (err) {
    if (errorCode(err) === 4001) return { kind: "wallet-rejected" };
    return { kind: "uncertain", guidance: UNCERTAIN_GUIDANCE };
  }

  if (typeof raw !== "string" || !HASH_RE.test(raw)) {
    return { kind: "uncertain", guidance: UNCERTAIN_GUIDANCE };
  }

  const record: DepositRecord = {
    account: quote.account,
    recipient: quote.recipient,
    amountWei: quote.amountWei,
    configVersion: quote.configVersion,
    l1ChainId: quote.l1ChainId,
    l2ChainId: quote.l2ChainId,
    l2GenesisHash: quote.l2GenesisHash,
    schemaVersion: 1,
    l1Hash: raw,
    submittedAt: deps.now(),
    phase: "l1-pending",
  };
  try {
    await deps.onHash(record);
  } catch {
    return {
      kind: "uncertain",
      guidance: `${UNCERTAIN_GUIDANCE} Observed hash ${record.l1Hash}.`,
    };
  }
  return { kind: "submitted", record };
}

/**
 * Fields come from the frozen quote only. `ctx` is not an input here:
 * a form edit after review must not change what MetaMask signs.
 */
function transactionFromQuote(quote: DepositQuote): Record<string, string> | null {
  if (!isDecimal(quote.amountWei) || !isDecimal(quote.l1GasLimit)) return null;
  const amount = BigInt(quote.amountWei);
  const gas = BigInt(quote.l1GasLimit);
  const value = hexQuantity(amount);
  if (BigInt(value) !== amount) return null;

  const tx: Record<string, string> = {
    from: quote.account,
    to: quote.portal,
    value,
    data: quote.data,
    gas: hexQuantity(gas),
  };

  const hasFee = quote.maxFeePerGasWei !== undefined;
  const hasPriority = quote.maxPriorityFeePerGasWei !== undefined;
  const hasLegacy = quote.gasPriceWei !== undefined;
  if (hasFee !== hasPriority) return null;
  if (hasFee && hasLegacy) return null;

  if (hasFee && hasPriority && quote.maxFeePerGasWei !== undefined && quote.maxPriorityFeePerGasWei !== undefined) {
    if (!isDecimal(quote.maxFeePerGasWei) || !isDecimal(quote.maxPriorityFeePerGasWei)) return null;
    tx.maxFeePerGas = hexQuantity(BigInt(quote.maxFeePerGasWei));
    tx.maxPriorityFeePerGas = hexQuantity(BigInt(quote.maxPriorityFeePerGasWei));
    return tx;
  }
  if (hasLegacy && quote.gasPriceWei !== undefined) {
    if (!isDecimal(quote.gasPriceWei)) return null;
    tx.gasPrice = hexQuantity(BigInt(quote.gasPriceWei));
    return tx;
  }
  return null;
}

const SEPOLIA_CHAIN = 11155111n;

async function recheckRecipient(deps: SubmitDeps, quote: DepositQuote): Promise<SubmitResult | null> {
  try {
    await confirmRecipientCode(
      { replica: deps.replica, sequencer: deps.sequencer },
      quote.recipient,
      quote.account,
    );
    return null;
  } catch (err) {
    const reason = err instanceof QuoteError ? err.message : "recipient code unavailable";
    return { kind: "blocked", reason };
  }
}

async function readWalletNow(provider: Eip1193Provider, quote: DepositQuote): Promise<SubmitResult | null> {
  let chain: unknown;
  let accounts: unknown;
  try {
    chain = await provider.request({ method: "eth_chainId", params: [] });
    accounts = await provider.request({ method: "eth_accounts", params: [] });
  } catch {
    return { kind: "blocked", reason: "wallet state unavailable" };
  }
  if (!isSepolia(chain) || !isSepolia(quote.l1ChainId)) {
    return { kind: "blocked", reason: "wallet chain changed" };
  }
  const stillConnected =
    Array.isArray(accounts) &&
    accounts.some((item) => typeof item === "string" && item.toLowerCase() === quote.account.toLowerCase());
  if (!stillConnected) {
    return { kind: "blocked", reason: "wallet account changed" };
  }
  return null;
}

function isSepolia(value: unknown): boolean {
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value) === SEPOLIA_CHAIN;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value) === SEPOLIA_CHAIN;
  return false;
}

async function readBalance(provider: Eip1193Provider, account: string): Promise<bigint | null> {
  try {
    const raw = await provider.request({ method: "eth_getBalance", params: [account, "latest"] });
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) return null;
    return BigInt(raw);
  } catch {
    return null;
  }
}

function errorCode(err: unknown): number | null {
  if (err === null || typeof err !== "object" || !("code" in err)) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "number" && Number.isInteger(code)) return code;
  return null;
}

function isDecimal(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value);
}

function hexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}
