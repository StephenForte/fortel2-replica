/** Shared bridge types. `bridge-config.json` is written by B2; this is the shape only. */

export type BridgeConfig = {
  configVersion: string;
  l1: {
    chainId: number;
    chainIdHex: string;
    name: string;
    rpc: string;
    explorerTx: string;
  };
  l2: {
    chainId: number;
    chainIdHex: string;
    name: string;
    genesisHash: string;
    sequencerRpc: string;
    replicaRpc: string;
    explorerTx: string;
  };
  contracts: {
    optimismPortal: string;
    systemConfig: string;
    metamaskDelegationManager: string;
  };
  deposit: {
    l2GasLimit: string;
    capWei: string;
    presetsWei: string[];
    defaultWei: string;
    quoteTtlSeconds: number;
    l1GasFloor: string;
    l1GasCeiling: string;
    l1GasMultiplier: number;
    pollSeconds: number;
  };
};

export type Phase =
  | "disconnected"
  | "editing"
  | "reviewing"
  | "ready"
  | "awaiting-wallet"
  | "l1-pending"
  | "l1-included"
  | "l2-pending"
  | "l2-received"
  | "replica-confirmed"
  | "wallet-rejected"
  | "l1-reverted"
  | "replaced"
  | "cancelled"
  | "configuration-mismatch"
  | "unsupported-deposit"
  | "l2-execution-failed"
  | "tracking-unavailable";

/** `amountWei` is a base-10 integer string. */
export type DepositIntent = {
  account: string;
  recipient: string;
  amountWei: string;
  configVersion: string;
  l1ChainId: number;
  l2ChainId: number;
  l2GenesisHash: string;
};

/**
 * Wei and gas quantities are base-10 integer strings so a quote can be frozen
 * and later copied into a JSON journal without floating point.
 */
export type DepositQuote = DepositIntent & {
  createdAt: number;
  expiresAt: number;
  portal: string;
  data: string;
  l2GasLimit: string;
  l1GasEstimate: string;
  l1GasLimit: string;
  maxFeePerGasWei?: string;
  maxPriorityFeePerGasWei?: string;
  gasPriceWei?: string;
  maxNetworkFeeWei: string;
  maxWalletDebitWei: string;
};

export type DepositRecord = DepositIntent & {
  schemaVersion: 1;
  l1Hash: string;
  submittedAt?: number;
  l1BlockHash?: string;
  l1BlockNumber?: number;
  depositLogIndex?: number;
  sourceHash?: string;
  l2Hash?: string;
  actualL1FeeWei?: string;
  l1GasUsed?: string;
  effectiveGasPriceWei?: string;
  lastCheckedAt?: number;
  phase: Phase;
  lastError?: string;
};

/** One OptimismPortal `TransactionDeposited` log, after the version-0 layout check. */
export type DecodedDeposit = {
  from: string;
  to: string;
  mint: bigint;
  value: bigint;
  gas: bigint;
  isCreation: boolean;
  data: string;
  logIndex: number;
  l1BlockHash: string;
};
