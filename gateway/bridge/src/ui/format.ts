import type { DepositRecord, Phase } from "../types";

/** Wei display is integer math. A float is never used to scale ETH. */

/** Principal that did not arrive, or that a successor already represents. */
const NON_TRANSFER: ReadonlySet<Phase> = new Set([
  "replaced",
  "cancelled",
  "l1-reverted",
  "l2-execution-failed",
]);

/**
 * ETH transferred is principal only. Fees stay out. A replaced original is
 * omitted when its successor is in the same list, and a reverted, cancelled,
 * or failed deposit does not count.
 */
export function transferredPrincipalWei(records: readonly DepositRecord[]): bigint {
  const present = new Set(records.map((record) => record.l1Hash.toLowerCase()));
  const seen = new Set<string>();
  let total = 0n;
  for (const record of records) {
    const hash = record.l1Hash.toLowerCase();
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (NON_TRANSFER.has(record.phase)) continue;
    if (record.replacedBy !== undefined && present.has(record.replacedBy.toLowerCase())) continue;
    try {
      const amount = BigInt(record.amountWei);
      if (amount > 0n) total += amount;
    } catch {
      continue;
    }
  }
  return total;
}

const WEI_PER_ETH = 10n ** 18n;

export function formatEth(wei: bigint): string {
  const negative = wei < 0n;
  const value = negative ? -wei : wei;
  const whole = value / WEI_PER_ETH;
  const fraction = (value % WEI_PER_ETH).toString(10).padStart(18, "0").replace(/0+$/, "");
  const body = fraction.length > 0 ? `${whole.toString(10)}.${fraction}` : whole.toString(10);
  return negative ? `-${body}` : body;
}

export function formatEthLabel(wei: bigint | string): string {
  const value = typeof wei === "string" ? BigInt(wei) : wei;
  return `${formatEth(value)} ETH`;
}

export function formatTime(ms: number): string {
  if (!Number.isSafeInteger(ms)) return "unknown time";
  return new Date(ms).toISOString();
}

/** Whole seconds remaining, rounded up, using integer division only. */
export function secondsUntil(expiresAt: number, nowMs: number): number {
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(nowMs)) return 0;
  const delta = expiresAt - nowMs;
  if (delta <= 0) return 0;
  return Number((BigInt(delta) + 999n) / 1000n);
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Explorer templates are `https://…/{hash}`. Anything else is not linked. */
export function explorerHref(template: string, hash: string): string | null {
  if (!HASH.test(hash) || !template.includes("{hash}")) return null;
  const url = template.replaceAll("{hash}", hash);
  if (!/^https:\/\//.test(url)) return null;
  return url;
}

export function stepLabel(phase: string | undefined): string {
  switch (phase) {
    case "l1-included":
    case "l2-pending":
      return "Included on Sepolia";
    case "l2-received":
      return "Received on ForteL2";
    case "replica-confirmed":
      return "Confirmed by replica";
    case "l1-pending":
      return "Included on Sepolia";
    default:
      return "none";
  }
}

export function observedAt(record: {
  lastProvenPhase?: string;
  l1IncludedObservedAt?: number;
  l2ObservedAt?: number;
  replicaObservedAt?: number;
  lastCheckedAt?: number;
}): number | null {
  if (record.lastProvenPhase === "replica-confirmed" && record.replicaObservedAt !== undefined) {
    return record.replicaObservedAt;
  }
  if (
    (record.lastProvenPhase === "l2-received" || record.lastProvenPhase === "l2-execution-failed") &&
    record.l2ObservedAt !== undefined
  ) {
    return record.l2ObservedAt;
  }
  if (record.l1IncludedObservedAt !== undefined && record.lastProvenPhase !== undefined) {
    return record.l1IncludedObservedAt;
  }
  if (record.lastCheckedAt !== undefined) return record.lastCheckedAt;
  return null;
}
