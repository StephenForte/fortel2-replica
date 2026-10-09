import { afterEach, describe, expect, it, vi } from "vitest";

import { L1_READ, L2_READ, RpcError, RpcUnavailableError, createRpcClient } from "../src/rpc";

const url = "https://example.invalid/rpc";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("allowlists", () => {
  it("lists only the read methods from the plan", () => {
    expect([...L1_READ]).toEqual([
      "eth_chainId",
      "eth_getBalance",
      "eth_getCode",
      "eth_call",
      "eth_getBlockByNumber",
      "eth_getBlockByHash",
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
      "eth_estimateGas",
      "eth_gasPrice",
      "eth_maxPriorityFeePerGas",
      "eth_feeHistory",
    ]);
    expect([...L2_READ]).toEqual([
      "eth_chainId",
      "eth_getBalance",
      "eth_getCode",
      "eth_getBlockByNumber",
      "eth_getBlockByHash",
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
    ]);
    for (const method of [...L1_READ, ...L2_READ]) {
      expect(method).not.toBe("eth_sendRawTransaction");
      expect(method).not.toBe("eth_sendTransaction");
    }
  });

  it("does not call fetch for a method off the list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const l1 = createRpcClient({ url, allowedMethods: L1_READ, timeoutMs: 1000 });
    const l2 = createRpcClient({ url, allowedMethods: L2_READ, timeoutMs: 1000 });
    await expect(l1.call("eth_sendRawTransaction", ["0x"])).rejects.toBeInstanceOf(RpcError);
    await expect(l1.call("eth_sendTransaction", [])).rejects.toBeInstanceOf(RpcError);
    await expect(l2.call("eth_call", [])).rejects.toBeInstanceOf(RpcError);
    await expect(l2.call("eth_sendRawTransaction", [])).rejects.toBeInstanceOf(RpcError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createRpcClient", () => {
  it("returns a result only when the id matches", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as { id: number; method: string };
      expect(sent.method).toBe("eth_chainId");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: "0x354" }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createRpcClient({ url, allowedMethods: L2_READ, timeoutMs: 1000 });
    await expect(client.call("eth_chainId", [])).resolves.toBe("0x354");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched id, a string id, and malformed JSON", async () => {
    const client = createRpcClient({ url, allowedMethods: L1_READ, timeoutMs: 1000 });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 99, result: "0x1" }), { status: 200 })),
    );
    await expect(client.call("eth_chainId", [])).rejects.toBeInstanceOf(RpcError);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const sent = JSON.parse(String(init.body)) as { id: number };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: String(sent.id), result: "0x1" }), {
          status: 200,
        });
      }),
    );
    await expect(client.call("eth_chainId", [])).rejects.toBeInstanceOf(RpcError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));
    await expect(client.call("eth_chainId", [])).rejects.toBeInstanceOf(RpcError);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ jsonrpc: "2.0", id: 1, result: "0x1" }]), { status: 200 })),
    );
    await expect(client.call("eth_chainId", [])).rejects.toBeInstanceOf(RpcError);
  });

  it("maps a JSON-RPC error to RpcError and not a result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const sent = JSON.parse(String(init.body)) as { id: number };
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: sent.id,
            error: { code: -32000, message: "missing" },
            result: "0x1",
          }),
          { status: 200 },
        );
      }),
    );
    const client = createRpcClient({ url, allowedMethods: L1_READ, timeoutMs: 1000 });
    const error = await client.call("eth_chainId", []).then(
      () => {
        throw new Error("resolved");
      },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(RpcError);
    expect(error).not.toBeInstanceOf(RpcUnavailableError);
    expect((error as RpcError).code).toBe(-32000);
  });

  it("maps HTTP 429, transport failures, and aborts to RpcUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 429 }),
      ),
    );
    const limited = createRpcClient({ url, allowedMethods: L1_READ, timeoutMs: 1000 });
    await expect(limited.call("eth_chainId", [])).rejects.toBeInstanceOf(RpcUnavailableError);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("failed to fetch");
      }),
    );
    const offline = createRpcClient({ url, allowedMethods: L1_READ, timeoutMs: 1000 });
    await expect(offline.call("eth_chainId", [])).rejects.toBeInstanceOf(RpcUnavailableError);

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      }),
    );
    const slow = createRpcClient({ url, allowedMethods: L1_READ, timeoutMs: 20 });
    await expect(slow.call("eth_chainId", [])).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it("aborts a body that stalls after the headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const stream = new ReadableStream({
          start(controller) {
            const fail = () => controller.error(new DOMException("The operation was aborted", "AbortError"));
            if (init.signal?.aborted) fail();
            else init.signal?.addEventListener("abort", fail, { once: true });
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }),
    );
    const client = createRpcClient({ url, allowedMethods: L1_READ, timeoutMs: 30 });
    await expect(client.call("eth_chainId", [])).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it("does not treat an HTTP error body as a result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 500 }),
      ),
    );
    const client = createRpcClient({ url, allowedMethods: L1_READ, timeoutMs: 1000 });
    await expect(client.call("eth_chainId", [])).rejects.toBeInstanceOf(RpcUnavailableError);
  });
});
