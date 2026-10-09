import { describe, expect, it } from "vitest";

import bridgeConfig from "../bridge-config.json";
import { loadConfig, verifyConfig, type ConfigFetch } from "../src/config";
import { RpcUnavailableError, type RpcClient } from "../src/rpc";
import type { BridgeConfig } from "../src/types";
import { createMockEip1193 } from "./mock-eip1193";

const cfg = bridgeConfig as BridgeConfig;
const OTHER_HASH = `0x${"11".repeat(32)}`;
const OTHER_CONFIG = "0x0000000000000000000000000000000000000002";

function word(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function scripted(handlers: Record<string, (params: readonly unknown[]) => unknown>): {
  client: RpcClient;
  calls: { method: string; params: readonly unknown[] }[];
} {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  return {
    calls,
    client: {
      async call(method: string, params: readonly unknown[] = []) {
        calls.push({ method, params });
        const handler = handlers[method];
        if (!handler) throw new Error(`unexpected ${method}`);
        return handler(params);
      },
    },
  };
}

function l1(overrides: Partial<Record<string, (params: readonly unknown[]) => unknown>> = {}) {
  return scripted({
    eth_chainId: () => cfg.l1.chainIdHex,
    eth_getCode: () => "0x6000",
    eth_call: () => word(cfg.contracts.systemConfig),
    ...overrides,
  });
}

function l2(overrides: Partial<Record<string, (params: readonly unknown[]) => unknown>> = {}) {
  return scripted({
    eth_chainId: () => cfg.l2.chainIdHex,
    eth_getBlockByNumber: () => ({ hash: cfg.l2.genesisHash }),
    ...overrides,
  });
}

function wallet(chainId = "0xaa36a7") {
  const mock = createMockEip1193();
  mock.handle("eth_chainId", () => chainId);
  return mock;
}

async function verify(
  parts: {
    walletChain?: string;
    l1?: ReturnType<typeof l1>;
    sequencer?: ReturnType<typeof l2>;
    replica?: ReturnType<typeof l2>;
  } = {},
) {
  const l1Side = parts.l1 ?? l1();
  const sequencer = parts.sequencer ?? l2();
  const replica = parts.replica ?? l2();
  const chain = wallet(parts.walletChain);
  const result = await verifyConfig({
    cfg,
    l1: l1Side.client,
    sequencer: sequencer.client,
    replica: replica.client,
    wallet: chain,
  });
  return { result, chain, l1Side, sequencer, replica };
}

describe("loadConfig", () => {
  it("reads /bridge-config.json and accepts the committed artifact", async () => {
    const seen: string[] = [];
    const fetchConfig: ConfigFetch = async (url) => {
      seen.push(url);
      return new Response(JSON.stringify(cfg), { status: 200 });
    };
    const result = await loadConfig(fetchConfig);
    expect(seen).toEqual(["/bridge-config.json"]);
    expect(result).toEqual({ ok: true, config: cfg });
  });

  it.each([
    ["not json", "{"],
    ["missing portal", drop(cfg, "contracts", "optimismPortal")],
    ["numeric wei", replace(cfg, ["deposit", "capWei"], 1)],
    ["fractional wei", replace(cfg, ["deposit", "l1GasFloor"], "500000.0")],
    ["hex wei", replace(cfg, ["deposit", "l2GasLimit"], "0x186a0")],
    ["bad address", replace(cfg, ["contracts", "systemConfig"], "portal")],
    ["chain id mismatch", replace(cfg, ["l1", "chainIdHex"], "0x1")],
    ["extra key", { ...cfg, extra: true }],
  ])("rejects %s as configuration-mismatch", async (_label, body) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const result = await loadConfig(async () => new Response(payload, { status: 200 }));
    expect(result.ok).toBe(false);
    if (!result.ok && "phase" in result) {
      expect(result.phase).toBe("configuration-mismatch");
      expect(result.reason.length).toBeGreaterThan(0);
    } else {
      throw new Error("expected a mismatch result");
    }
    expect(result).not.toHaveProperty("unavailable");
  });

  it("reports an outage without calling it a mismatch", async () => {
    await expect(loadConfig(async () => Promise.reject(new Error("offline")))).resolves.toEqual({
      ok: false,
      unavailable: true,
    });
    await expect(loadConfig(async () => new Response("no", { status: 503 }))).resolves.toEqual({
      ok: false,
      unavailable: true,
    });
  });
});

describe("verifyConfig", () => {
  it("accepts the live identity checked on 2026-10-08", async () => {
    const { result, l1Side, sequencer, replica } = await verify();
    expect(result).toEqual({ ok: true });
    expect(l1Side.calls.map((entry) => entry.method)).toEqual(["eth_chainId", "eth_getCode", "eth_call"]);
    expect(l1Side.calls[2]?.params).toEqual([
      { to: cfg.contracts.optimismPortal, data: "0x33d7e2bd" },
      "latest",
    ]);
    expect(sequencer.calls[1]?.params).toEqual(["0x0", false]);
    expect(replica.calls[1]?.params).toEqual(["0x0", false]);
    expect(sequencer.calls[0]?.params).toEqual([]);
  });

  it("rejects a wallet that is not on Sepolia", async () => {
    const { result } = await verify({ walletChain: "0x1" });
    expect(result).toMatchObject({ ok: false, phase: "configuration-mismatch" });
  });

  it("rejects a configured L1 chain that is not Sepolia even when that client agrees", async () => {
    const mainnet = structuredClone(cfg);
    mainnet.l1 = { ...cfg.l1, chainId: 1, chainIdHex: "0x1" };
    const l1Side = l1({ eth_chainId: () => "0x1" });
    const result = await verifyConfig({
      cfg: mainnet,
      l1: l1Side.client,
      sequencer: l2().client,
      replica: l2().client,
      wallet: wallet(),
    });
    expect(result).toMatchObject({ ok: false, phase: "configuration-mismatch" });
    if (!result.ok && "phase" in result) expect(result.reason).toMatch(/0xaa36a7/);
    expect(l1Side.calls.map((entry) => entry.method)).not.toContain("eth_getCode");
    expect(l1Side.calls.map((entry) => entry.method)).not.toContain("eth_call");
  });

  it("rejects an L1 chain id that is not the configured one", async () => {
    const { result } = await verify({ l1: l1({ eth_chainId: () => "0x1" }) });
    expect(result).toMatchObject({ ok: false, phase: "configuration-mismatch" });
  });

  it("rejects an empty portal", async () => {
    const { result } = await verify({ l1: l1({ eth_getCode: () => "0x" }) });
    expect(result).toMatchObject({ ok: false, phase: "configuration-mismatch" });
    if (!result.ok && "phase" in result) expect(result.reason).toMatch(/code/i);
  });

  it("rejects a portal whose systemConfig is not the configured address", async () => {
    const { result } = await verify({ l1: l1({ eth_call: () => word(OTHER_CONFIG) }) });
    expect(result).toMatchObject({ ok: false, phase: "configuration-mismatch" });
    if (!result.ok && "phase" in result) expect(result.reason).toMatch(/systemConfig/i);
  });

  it("rejects a sequencer genesis that is not the configured hash", async () => {
    const { result } = await verify({
      sequencer: l2({ eth_getBlockByNumber: () => ({ hash: OTHER_HASH }) }),
    });
    expect(result).toMatchObject({ ok: false, phase: "configuration-mismatch" });
    if (!result.ok && "phase" in result) expect(result.reason).toMatch(/sequencer genesis/i);
  });

  it("rejects a replica genesis that is not the configured hash", async () => {
    const { result } = await verify({
      replica: l2({ eth_getBlockByNumber: () => ({ hash: OTHER_HASH }) }),
    });
    expect(result).toMatchObject({ ok: false, phase: "configuration-mismatch" });
    if (!result.ok && "phase" in result) expect(result.reason).toMatch(/replica genesis/i);
  });

  it("rejects a sequencer that is not chain 852", async () => {
    const { result } = await verify({ sequencer: l2({ eth_chainId: () => "0x1" }) });
    expect(result).toMatchObject({ ok: false, phase: "configuration-mismatch" });
    if (!result.ok && "phase" in result) expect(result.reason).toMatch(/sequencer chain/i);
  });

  it("reports an outage instead of a mismatch", async () => {
    const down = scripted({
      eth_chainId: () => {
        throw new RpcUnavailableError("timeout");
      },
    });
    const { result } = await verify({ l1: down });
    expect(result).toEqual({ ok: false, unavailable: true });
    expect(result).not.toHaveProperty("phase");
  });
});

function drop(source: BridgeConfig, group: "contracts", key: string): unknown {
  const copy = structuredClone(source) as unknown as Record<string, Record<string, unknown>>;
  delete copy[group][key];
  return copy;
}

function replace(source: BridgeConfig, path: string[], value: unknown): unknown {
  const copy = structuredClone(source) as unknown as Record<string, unknown>;
  let cursor = copy;
  for (const key of path.slice(0, -1)) {
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
  return copy;
}
