import {
  AbiCoder,
  Interface,
  concat,
  encodeRlp,
  getAddress,
  getBytes,
  hexlify,
  id,
  keccak256,
  toBeHex,
  zeroPadValue,
} from "ethers";

import type { BridgeConfig, DecodedDeposit } from "./types";

/** Native ETH deposit gas. The matcher rejects every other value. */
const NATIVE_L2_GAS_LIMIT = 100_000n;

const PORTAL_ABI = [
  "function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable",
  "function systemConfig() view returns (address)",
  "event TransactionDeposited(address indexed from, address indexed to, uint256 indexed version, bytes opaqueData)",
] as const;

const portalInterface = new Interface(PORTAL_ABI);
const DEPOSIT_TOPIC = id("TransactionDeposited(address,address,uint256,bytes)");

const REDEEM_ABI = [
  "function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)",
] as const;
const redeemInterface = new Interface(REDEEM_ABI);
/** Observed on the 2026-10-08 MetaMask delegation fixture. */
export const REDEEM_DELEGATIONS_SELECTOR = id(
  "redeemDelegations(bytes[],bytes32[],bytes[])",
).slice(0, 10);

const ZERO_MODE = `0x${"00".repeat(32)}`;
const coder = AbiCoder.defaultAbiCoder();

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export type RpcLog = {
  address: string;
  topics: readonly string[];
  data: string;
  logIndex: string;
  blockHash: string;
};

export type RpcTransaction = {
  to: string | null;
  value: string;
  input?: string;
  data?: string;
};

export type MatchedDeposit = {
  recipient: string;
  amountWei: bigint;
  l2GasLimit: bigint;
};

/**
 * Positive decimal ETH with at most 18 fractional digits, returned as wei.
 * Rejects exponents, signs, whitespace, zero, and values above `capWei`.
 * The conversion is integer-only.
 */
export function parseEthAmount(s: string, capWei: bigint): bigint {
  if (typeof s !== "string" || typeof capWei !== "bigint" || capWei < 0n) {
    throw new ProtocolError("amount: malformed");
  }
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(s)) {
    throw new ProtocolError("amount: malformed");
  }
  const [whole, frac = ""] = s.split(".");
  const wei = BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
  if (wei === 0n) throw new ProtocolError("amount: zero");
  if (wei > capWei) throw new ProtocolError("amount: above cap");
  return wei;
}

/** EIP-55 checksummed address. All-lower and all-upper pass; mixed case must checksum. */
export function validateRecipient(s: string): string {
  if (typeof s !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(s)) {
    throw new ProtocolError("recipient: malformed");
  }
  const hex = s.slice(2);
  const uniform = hex === hex.toLowerCase() || hex === hex.toUpperCase();
  let checksummed: string;
  try {
    checksummed = getAddress(s);
  } catch {
    throw new ProtocolError("recipient: bad checksum");
  }
  if (!uniform && checksummed !== s) {
    throw new ProtocolError("recipient: bad checksum");
  }
  if (BigInt(checksummed) === 0n) {
    throw new ProtocolError("recipient: zero address");
  }
  return checksummed;
}

export function encodeDepositCall(recipient: string, amountWei: bigint, l2Gas: bigint): string {
  const to = validateRecipient(recipient);
  if (typeof amountWei !== "bigint" || amountWei < 0n) {
    throw new ProtocolError("amount: malformed");
  }
  if (typeof l2Gas !== "bigint" || l2Gas < 0n || l2Gas > 0xffff_ffff_ffff_ffffn) {
    throw new ProtocolError("gas: malformed");
  }
  return portalInterface.encodeFunctionData("depositTransaction", [to, amountWei, l2Gas, false, "0x"]);
}

export function matchDirectPortalCall(tx: RpcTransaction, cfg: BridgeConfig): MatchedDeposit | null {
  if (!sameAddress(tx.to, cfg.contracts.optimismPortal)) return null;
  const input = transactionInput(tx);
  if (input === null) return null;
  const txValue = quantity(tx.value);
  if (txValue === null) return null;
  return matchDepositCalldata(input, txValue, cfg);
}

/**
 * MetaMask `redeemDelegations` wrapper. The outer transaction value may be zero;
 * the packed execution value must equal `depositTransaction._value`. One item
 * per array, mode all zeros, no batches, no trailing bytes.
 */
export function matchDelegationWrapper(tx: RpcTransaction, cfg: BridgeConfig): MatchedDeposit | null {
  if (!sameAddress(tx.to, cfg.contracts.metamaskDelegationManager)) return null;
  const input = transactionInput(tx);
  if (input === null || input.length < 10) return null;
  if (input.slice(0, 10).toLowerCase() !== REDEEM_DELEGATIONS_SELECTOR) return null;

  let decoded: readonly unknown[];
  try {
    decoded = redeemInterface.decodeFunctionData("redeemDelegations", input);
  } catch {
    return null;
  }
  const contexts = hexList(decoded[0]);
  const modes = hexList(decoded[1]);
  const executions = hexList(decoded[2]);
  if (contexts === null || modes === null || executions === null) return null;

  let canonical: string;
  try {
    canonical = redeemInterface.encodeFunctionData("redeemDelegations", [contexts, modes, executions]);
  } catch {
    return null;
  }
  if (canonical.toLowerCase() !== input.toLowerCase()) return null;
  if (contexts.length !== 1 || modes.length !== 1 || executions.length !== 1) return null;
  if (modes[0].toLowerCase() !== ZERO_MODE) return null;

  let packed: Uint8Array;
  try {
    packed = getBytes(executions[0]);
  } catch {
    return null;
  }
  if (packed.length < 52) return null;
  const target = hexlify(packed.subarray(0, 20));
  if (!sameAddress(target, cfg.contracts.optimismPortal)) return null;
  const innerValue = BigInt(hexlify(packed.subarray(20, 52)));
  const innerCall = hexlify(packed.subarray(52));
  return matchDepositCalldata(innerCall, innerValue, cfg);
}

/**
 * Version-0 `TransactionDeposited`. `portal` is the expected log address.
 * `logIndex` is the log's own field (block-global), not an array position.
 * `opaqueData` is ABI `bytes` of exactly 73 bytes.
 */
export function decodeDepositEvent(log: RpcLog, portal: string): DecodedDeposit {
  if (!sameAddress(log.address, portal)) {
    throw new ProtocolError("portal: address mismatch");
  }
  if (log.topics.length !== 4 || log.topics[0].toLowerCase() !== DEPOSIT_TOPIC) {
    throw new ProtocolError("event: not TransactionDeposited");
  }
  let version: bigint;
  try {
    version = BigInt(log.topics[3]);
  } catch {
    throw new ProtocolError("version: malformed");
  }
  if (version !== 0n) throw new ProtocolError("version: expected 0");

  const from = addressFromTopic(log.topics[1], "from");
  const to = addressFromTopic(log.topics[2], "to");
  const opaque = decodeOpaque(log.data);
  const mint = BigInt(hexlify(opaque.subarray(0, 32)));
  const value = BigInt(hexlify(opaque.subarray(32, 64)));
  const gas = BigInt(hexlify(opaque.subarray(64, 72)));
  const flag = opaque[72];
  if (flag !== 0 && flag !== 1) throw new ProtocolError("isCreation: invalid");

  return {
    from,
    to,
    mint,
    value,
    gas,
    isCreation: flag === 1,
    data: "0x",
    logIndex: quantityToNumber(log.logIndex, "logIndex"),
    l1BlockHash: bytes32(log.blockHash, "l1BlockHash"),
  };
}

/**
 * User-deposit source hash (domain 0) and the type-0x7e L2 transaction hash.
 * The event `from` is already the L2 sender; do not alias it again.
 * The RLP boolean is `isSystemTx = false`, which is not the portal `isCreation` flag.
 */
export function deriveDeposit(decoded: DecodedDeposit): { sourceHash: string; l2Hash: string } {
  const sourceHash = userDepositSourceHash(decoded.l1BlockHash, decoded.logIndex);
  const l2Hash = keccak256(
    concat([
      "0x7e",
      encodeRlp([
        bytes32(sourceHash, "sourceHash"),
        addressBytes(decoded.from, "from"),
        addressBytes(decoded.to, "to"),
        rlpUint(decoded.mint),
        rlpUint(decoded.value),
        rlpUint(decoded.gas),
        "0x",
        byteHex(decoded.data, "data"),
      ]),
    ]),
  );
  return { sourceHash, l2Hash };
}

function matchDepositCalldata(input: string, valueWei: bigint, cfg: BridgeConfig): MatchedDeposit | null {
  let configuredGas: bigint;
  try {
    configuredGas = BigInt(cfg.deposit.l2GasLimit);
  } catch {
    return null;
  }
  if (configuredGas !== NATIVE_L2_GAS_LIMIT) return null;
  let decoded: readonly unknown[];
  try {
    decoded = portalInterface.decodeFunctionData("depositTransaction", input);
  } catch {
    return null;
  }
  const to = decoded[0];
  const value = decoded[1];
  const gas = decoded[2];
  const isCreation = decoded[3];
  const data = decoded[4];
  if (typeof to !== "string" || typeof value !== "bigint" || typeof gas !== "bigint") return null;
  if (typeof isCreation !== "boolean" || typeof data !== "string") return null;

  let canonical: string;
  try {
    canonical = portalInterface.encodeFunctionData("depositTransaction", [to, value, gas, isCreation, data]);
  } catch {
    return null;
  }
  if (canonical.toLowerCase() !== input.toLowerCase()) return null;
  if (value !== valueWei) return null;
  if (isCreation !== false) return null;
  try {
    if (getBytes(data).length !== 0) return null;
  } catch {
    return null;
  }
  if (gas !== NATIVE_L2_GAS_LIMIT) return null;

  try {
    return { recipient: validateRecipient(to), amountWei: value, l2GasLimit: gas };
  } catch {
    return null;
  }
}

function decodeOpaque(data: string): Uint8Array {
  let opaque: string;
  try {
    const decoded = coder.decode(["bytes"], data);
    opaque = decoded[0] as string;
  } catch {
    throw new ProtocolError("opaque: undecodable");
  }
  const raw = getBytes(opaque);
  if (raw.length !== 73) throw new ProtocolError(`opaque length: ${raw.length}`);
  const canonical = coder.encode(["bytes"], [opaque]);
  if (canonical.toLowerCase() !== data.toLowerCase()) {
    throw new ProtocolError("opaque: trailing bytes");
  }
  return raw;
}

function userDepositSourceHash(l1BlockHash: string, logIndex: number): string {
  const block = getBytes(bytes32(l1BlockHash, "l1BlockHash"));
  if (!Number.isInteger(logIndex) || logIndex < 0) {
    throw new ProtocolError("logIndex: malformed");
  }
  const inner = keccak256(concat([block, toBeHex(logIndex, 32)]));
  const domain = zeroPadValue("0x00", 32);
  return keccak256(concat([domain, inner]));
}

/** Minimal big-endian. Zero is the empty byte string, matching RLP integers. */
function rlpUint(n: bigint): string {
  if (typeof n !== "bigint" || n < 0n) throw new ProtocolError("rlp: integer");
  if (n === 0n) return "0x";
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return `0x${hex}`;
}

function addressBytes(addr: string, label: string): string {
  let bytes: Uint8Array;
  try {
    bytes = getBytes(addr);
  } catch {
    throw new ProtocolError(`${label}: address`);
  }
  if (bytes.length !== 20) throw new ProtocolError(`${label}: address`);
  return hexlify(bytes);
}

function byteHex(data: string, label: string): string {
  try {
    return hexlify(getBytes(data));
  } catch {
    throw new ProtocolError(`${label}: bytes`);
  }
}

function bytes32(hex: string, label: string): string {
  let bytes: Uint8Array;
  try {
    bytes = getBytes(hex);
  } catch {
    throw new ProtocolError(`${label}: hash`);
  }
  if (bytes.length !== 32) throw new ProtocolError(`${label}: hash`);
  return hexlify(bytes);
}

function addressFromTopic(topic: string, label: string): string {
  const bytes = getBytes(bytes32(topic, label));
  for (let i = 0; i < 12; i++) {
    if (bytes[i] !== 0) throw new ProtocolError(`${label}: topic padding`);
  }
  return getAddress(hexlify(bytes.subarray(12)));
}

function quantityToNumber(hex: string, label: string): number {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new ProtocolError(`${label}: quantity`);
  }
  const value = BigInt(hex);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolError(`${label}: too large`);
  return Number(value);
}

function quantity(hex: string): bigint | null {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

function transactionInput(tx: RpcTransaction): string | null {
  const input = tx.input ?? tx.data;
  if (typeof input !== "string" || !/^0x[0-9a-fA-F]*$/.test(input) || input.length % 2 !== 0) {
    return null;
  }
  return input;
}

function sameAddress(a: string | null | undefined, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(a) || !/^0x[0-9a-fA-F]{40}$/.test(b)) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function hexList(value: unknown): string[] | null {
  const list = asArray(value);
  if (list === null) return null;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || !/^0x[0-9a-fA-F]*$/.test(item)) return null;
    out.push(item);
  }
  return out;
}

function asArray(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object" && typeof (value as { length?: unknown }).length === "number") {
    return Array.from(value as ArrayLike<unknown>);
  }
  return null;
}
