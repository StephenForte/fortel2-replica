import { AbiCoder, Interface, concat, getAddress, getBytes, hexlify, toBeHex, zeroPadValue } from "ethers";
import { describe, expect, it } from "vitest";

import {
  ProtocolError,
  REDEEM_DELEGATIONS_SELECTOR,
  decodeDepositEvent,
  deriveDeposit,
  encodeDepositCall,
  matchDelegationWrapper,
  matchDirectPortalCall,
  parseEthAmount,
  validateRecipient,
  type RpcTransaction,
} from "../src/bridge-protocol";
import type { BridgeConfig, DecodedDeposit, DepositRecord } from "../src/types";
import l1BlockFile from "./fixtures/b1-fixture-57b6-l1-block.json";
import l1ReceiptFile from "./fixtures/b1-fixture-57b6-l1-receipt.json";
import l1TxFile from "./fixtures/b1-fixture-57b6-l1-tx.json";
import l2ReceiptFile from "./fixtures/b1-fixture-57b6-l2-receipt.json";
import l2TxFile from "./fixtures/b1-fixture-57b6-l2-tx.json";

const CAP_WEI = 20_000_000_000_000_000n;
const SOURCE_HASH = "0xe020a2def6498d67eef5fc37796193bd43da221463ca384b915e38fa83794712";
const L2_HASH = "0x6229a0743818135998ce745362f93b72dfca952e9cd1b71c1e81b54d3d2c53b9";
const L1_TX_HASH = "0x57b64e5ba293e42bbc6d3ce9d5eebf39b909eebff84973d1f71c1b35c45d8fa3";
const BLOCK_HASH = "0xa43b7375f6ccc15c46cf839751a2665799016ed55a8f240b4ff88e673333a857";

const cfg: BridgeConfig = {
  configVersion: "852-sepolia-2026-10-08.1",
  l1: {
    chainId: 11155111,
    chainIdHex: "0xaa36a7",
    name: "Sepolia",
    rpc: "https://sepolia.gateway.tenderly.co",
    explorerTx: "https://sepolia.etherscan.io/tx/{hash}",
  },
  l2: {
    chainId: 852,
    chainIdHex: "0x354",
    name: "ForteL2 Sepolia",
    genesisHash: "0xe242b1a3312b509e7df1496847f0bd0b115cb66676b1e973a355296c99e2386d",
    sequencerRpc: "https://fortel2-sequencer-rpc.onrender.com/",
    replicaRpc: "/",
    explorerTx: "https://settlementos-explorer-ihgo.onrender.com/fortel2-sepolia/tx/{hash}",
  },
  contracts: {
    optimismPortal: "0xf8c7da6c009d5d05bb98f8cd8286b9b838a3b54e",
    systemConfig: "0x7c799f23a427328831be0a8206a525a9bc886bde",
    metamaskDelegationManager: "0xdb9b1e94b5b69df7e401ddbede43491141047db3",
  },
  deposit: {
    l2GasLimit: "100000",
    capWei: "20000000000000000",
    presetsWei: ["1000000000000000", "2000000000000000", "5000000000000000"],
    defaultWei: "2000000000000000",
    quoteTtlSeconds: 60,
    l1GasFloor: "500000",
    l1GasCeiling: "1000000",
    l1GasMultiplier: 2,
    pollSeconds: 12,
  },
};

const portalAbi = new Interface([
  "function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable",
]);
const redeemAbi = new Interface([
  "function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)",
]);

const l1Tx = l1TxFile.result;
const l1Receipt = l1ReceiptFile.result;
const l1Block = l1BlockFile.result;
const l2Tx = l2TxFile.result;
const l2Receipt = l2ReceiptFile.result;
const portalLog = l1Receipt.logs[0];

function directTx(input: string, value: bigint, to = cfg.contracts.optimismPortal): RpcTransaction {
  return { to, value: toBeHex(value), input };
}

function pack(target: string, value: bigint, calldata: string): string {
  return hexlify(concat([getBytes(target), toBeHex(value, 32), calldata]));
}

function wrapperTx(execution: string, mode = `0x${"00".repeat(32)}`, count = 1): RpcTransaction {
  const input = redeemAbi.encodeFunctionData("redeemDelegations", [
    Array.from({ length: count }, () => "0x01"),
    Array.from({ length: count }, () => mode),
    Array.from({ length: count }, () => execution),
  ]);
  return { to: cfg.contracts.metamaskDelegationManager, value: "0x0", input };
}

describe("fixture 0x57b6…8fa3", () => {
  it("matches the delegation wrapper and derives the recorded L2 deposit", () => {
    expect(l1Tx.hash).toBe(L1_TX_HASH);
    expect(l1Receipt.status).toBe("0x1");
    expect(l1Receipt.to).toBe(cfg.contracts.metamaskDelegationManager);
    expect(l1Receipt.blockHash).toBe(BLOCK_HASH);
    expect(l1Block.hash).toBe(BLOCK_HASH);
    expect(portalLog.blockHash).toBe(BLOCK_HASH);
    expect(portalLog.logIndex).toBe("0x4f");
    expect(l1Receipt.gasUsed).toBe("0x3154f");
    expect(l1Receipt.effectiveGasPrice).toBe("0xa7068d47");
    expect(BigInt(l1Receipt.gasUsed) * BigInt(l1Receipt.effectiveGasPrice)).toBe(566_225_880_050_665n);

    const matched = matchDelegationWrapper(l1Tx, cfg);
    expect(matched).not.toBeNull();
    expect(matchDirectPortalCall(l1Tx, cfg)).toBeNull();
    expect(REDEEM_DELEGATIONS_SELECTOR).toBe("0xcef6d209");
    expect(l1Tx.input.startsWith("0xcef6d209")).toBe(true);

    const decodedLogs = l1Receipt.logs.flatMap((log) => {
      try {
        return [decodeDepositEvent(log, cfg.contracts.optimismPortal)];
      } catch {
        return [];
      }
    });
    expect(decodedLogs).toHaveLength(1);
    const decoded = decodedLogs[0];
    expect(decoded.logIndex).toBe(0x4f);
    expect(decoded.isCreation).toBe(false);
    expect(decoded.data).toBe("0x");
    expect(decoded.gas).toBe(100_000n);
    expect(decoded.mint).toBe(decoded.value);
    expect(decoded.mint).toBe(parseEthAmount("0.002", CAP_WEI));
    expect(matched?.amountWei).toBe(decoded.value);
    expect(matched?.recipient.toLowerCase()).toBe(decoded.to.toLowerCase());
    expect(decoded.to.toLowerCase()).toBe(l2Tx.to.toLowerCase());
    expect(decoded.from.toLowerCase()).toBe(l2Tx.from.toLowerCase());

    const derived = deriveDeposit(decoded);
    expect(derived.sourceHash).toBe(SOURCE_HASH);
    expect(derived.l2Hash).toBe(L2_HASH);
    expect(l2Tx.sourceHash).toBe(SOURCE_HASH);
    expect(l2Tx.hash).toBe(L2_HASH);
    expect(l2Tx.type).toBe("0x7e");
    expect(BigInt(l2Tx.mint)).toBe(decoded.mint);
    expect(BigInt(l2Tx.value)).toBe(decoded.value);
    expect(BigInt(l2Tx.gas)).toBe(decoded.gas);
    expect(l2Tx.input).toBe("0x");
    expect(l2Receipt.status).toBe("0x1");
    expect(l2Receipt.blockHash).toBe(l2Tx.blockHash);
    expect(l2Receipt.blockHash.startsWith("0xb1cb4fbb")).toBe(true);

    const arrayIndex = l1Receipt.logs.findIndex((log) => log.address === portalLog.address);
    expect(arrayIndex).toBe(0);
    expect(decoded.logIndex).not.toBe(arrayIndex);
    const fromArrayPosition = deriveDeposit({ ...decoded, logIndex: arrayIndex });
    expect(fromArrayPosition.sourceHash).not.toBe(SOURCE_HASH);
    expect(fromArrayPosition.l2Hash).not.toBe(L2_HASH);
  });

  it("changes the hash when the log index or block hash is wrong", () => {
    const decoded = decodeDepositEvent(portalLog, cfg.contracts.optimismPortal);
    const wrongIndex = deriveDeposit({ ...decoded, logIndex: decoded.logIndex + 1 });
    expect(wrongIndex.sourceHash).not.toBe(SOURCE_HASH);
    expect(wrongIndex.l2Hash).not.toBe(L2_HASH);
    const flipped = `0x${decoded.l1BlockHash.slice(2, 3) === "a" ? "b" : "a"}${decoded.l1BlockHash.slice(3)}`;
    const wrongBlock = deriveDeposit({ ...decoded, l1BlockHash: flipped });
    expect(wrongBlock.sourceHash).not.toBe(SOURCE_HASH);
    expect(wrongBlock.l2Hash).not.toBe(L2_HASH);
  });
});

describe("decodeDepositEvent", () => {
  it("rejects version 1, bad opaque lengths, and the wrong portal", () => {
    const version1 = {
      ...portalLog,
      topics: [portalLog.topics[0], portalLog.topics[1], portalLog.topics[2], zeroPadValue("0x01", 32)],
    };
    expect(() => decodeDepositEvent(version1, cfg.contracts.optimismPortal)).toThrow(ProtocolError);
    expect(() => decodeDepositEvent(version1, cfg.contracts.optimismPortal)).toThrow(/version/);

    for (const length of [72, 74]) {
      const body = `0x${"11".repeat(length)}`;
      const data = AbiCoder.defaultAbiCoder().encode(["bytes"], [body]);
      const log = { ...portalLog, data };
      expect(() => decodeDepositEvent(log, cfg.contracts.optimismPortal)).toThrow(/opaque length/);
    }

    const wrongPortal = { ...portalLog, address: cfg.contracts.metamaskDelegationManager };
    expect(() => decodeDepositEvent(wrongPortal, cfg.contracts.optimismPortal)).toThrow(/portal/);
  });
});

describe("portal calls", () => {
  const recipient = validateRecipient(`0x${"ab".repeat(20)}`);
  const amount = 2_000_000_000_000_000n;

  it("round-trips a direct depositTransaction through encode and match", () => {
    const input = encodeDepositCall(recipient, amount, 100_000n);
    expect(input.startsWith("0xe9e05c42")).toBe(true);
    const matched = matchDirectPortalCall(directTx(input, amount), cfg);
    expect(matched).toEqual({ recipient, amountWei: amount, l2GasLimit: 100_000n });
    expect(matchDelegationWrapper(directTx(input, amount), cfg)).toBeNull();
  });

  it("rejects direct calls that are not a native deposit", () => {
    const good = encodeDepositCall(recipient, amount, 100_000n);
    expect(matchDirectPortalCall(directTx(good, amount + 1n), cfg)).toBeNull();
    expect(matchDirectPortalCall(directTx(good, amount, cfg.contracts.systemConfig), cfg)).toBeNull();

    const nonempty = portalAbi.encodeFunctionData("depositTransaction", [
      recipient,
      amount,
      100_000,
      false,
      "0xabcd",
    ]);
    expect(matchDirectPortalCall(directTx(nonempty, amount), cfg)).toBeNull();

    const creation = portalAbi.encodeFunctionData("depositTransaction", [
      recipient,
      amount,
      100_000,
      true,
      "0x",
    ]);
    expect(matchDirectPortalCall(directTx(creation, amount), cfg)).toBeNull();

    const wrongGas = encodeDepositCall(recipient, amount, 100_001n);
    expect(matchDirectPortalCall(directTx(wrongGas, amount), cfg)).toBeNull();

    const trailed = `${good}00`;
    expect(matchDirectPortalCall(directTx(trailed, amount), cfg)).toBeNull();
  });

  it("rejects wrappers that are not one zero-mode portal execution", () => {
    const call = encodeDepositCall(recipient, amount, 100_000n);
    const good = pack(cfg.contracts.optimismPortal, amount, call);
    expect(matchDelegationWrapper(wrapperTx(good), cfg)).toEqual({
      recipient,
      amountWei: amount,
      l2GasLimit: 100_000n,
    });

    expect(matchDelegationWrapper(wrapperTx(good, `0x${"00".repeat(32)}`, 2), cfg)).toBeNull();
    expect(matchDelegationWrapper(wrapperTx(good, `0x${"00".repeat(31)}01`), cfg)).toBeNull();
    expect(
      matchDelegationWrapper(wrapperTx(pack(cfg.contracts.systemConfig, amount, call)), cfg),
    ).toBeNull();
    expect(
      matchDelegationWrapper(wrapperTx(pack(cfg.contracts.optimismPortal, amount + 1n, call)), cfg),
    ).toBeNull();
    expect(matchDelegationWrapper(wrapperTx(concat([good, "0x00"])), cfg)).toBeNull();
    const outer = wrapperTx(good);
    expect(matchDelegationWrapper({ ...outer, input: `${outer.input}00` }, cfg)).toBeNull();
    expect(matchDirectPortalCall(wrapperTx(good), cfg)).toBeNull();
  });
});

describe("parseEthAmount", () => {
  it("parses a positive decimal and the exact cap", () => {
    expect(parseEthAmount("0.002", CAP_WEI)).toBe(2_000_000_000_000_000n);
    expect(parseEthAmount("0.02", CAP_WEI)).toBe(CAP_WEI);
    expect(parseEthAmount("1", CAP_WEI * 100n)).toBe(10n ** 18n);
  });

  it("rejects exponents, signs, zero, overflow, and malformed text", () => {
    for (const bad of ["1e-3", "1E3", "-1", "0", "0.0", "0.0000000000000000001", "0.020000000000000001", " 0.1", "", ".", "0.1 ", "+1", "00.1"]) {
      expect(() => parseEthAmount(bad, CAP_WEI)).toThrow(ProtocolError);
    }
  });
});

describe("validateRecipient", () => {
  const checksummed = getAddress(`0x${"cd".repeat(20)}`);

  it("accepts uniform case and rejects a bad checksum or the zero address", () => {
    expect(validateRecipient(checksummed.toLowerCase())).toBe(checksummed);
    expect(validateRecipient(`0x${checksummed.slice(2).toUpperCase()}`)).toBe(checksummed);
    const chars = checksummed.split("");
    for (let i = 2; i < chars.length; i++) {
      if (/[a-f]/.test(chars[i])) {
        chars[i] = chars[i].toUpperCase();
        break;
      }
    }
    expect(() => validateRecipient(chars.join(""))).toThrow(ProtocolError);
    expect(() => validateRecipient(`0x${"0".repeat(40)}`)).toThrow(/zero address/);
    expect(() => validateRecipient("0x1234")).toThrow(ProtocolError);
  });
});

describe("types stay usable for later tasks", () => {
  it("accepts a deposit record shaped like the journal", () => {
    const decoded: DecodedDeposit = decodeDepositEvent(portalLog, cfg.contracts.optimismPortal);
    const record: DepositRecord = {
      account: decoded.from,
      recipient: decoded.to,
      amountWei: decoded.value.toString(10),
      configVersion: cfg.configVersion,
      l1ChainId: cfg.l1.chainId,
      l2ChainId: cfg.l2.chainId,
      l2GenesisHash: cfg.l2.genesisHash,
      schemaVersion: 1 as const,
      l1Hash: L1_TX_HASH,
      phase: "l1-included" as const,
      depositLogIndex: decoded.logIndex,
      l1BlockHash: decoded.l1BlockHash,
    };
    expect(record.schemaVersion).toBe(1);
    expect(record.phase).toBe("l1-included");
  });
});
