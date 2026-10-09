/**
 * Allowlisted JSON-RPC. A method that is not on the list throws before any
 * network call. There is no send method on either list.
 */

export class RpcError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

export class RpcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcUnavailableError";
  }
}

export const L1_READ = [
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
] as const;

export const L2_READ = [
  "eth_chainId",
  "eth_getBalance",
  "eth_getCode",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
] as const;

export type RpcClient = {
  call(method: string, params?: readonly unknown[]): Promise<unknown>;
};

export function createRpcClient(options: {
  url: string;
  allowedMethods: readonly string[];
  timeoutMs: number;
}): RpcClient {
  const allowed = new Set(options.allowedMethods);
  let nextId = 0;

  return {
    async call(method: string, params: readonly unknown[] = []): Promise<unknown> {
      if (!allowed.has(method)) {
        throw new RpcError(`method not allowed: ${method}`);
      }
      if (!Array.isArray(params)) {
        throw new RpcError("params must be an array");
      }

      const id = ++nextId;
      let body: string;
      try {
        body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      } catch {
        throw new RpcError("params are not JSON-encodable");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      let response: Response;
      try {
        response = await fetch(options.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        throw new RpcUnavailableError(isAbort(err) ? "timeout" : "network");
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429) {
        throw new RpcUnavailableError("HTTP 429");
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new RpcUnavailableError("network");
      }

      if (!response.ok) {
        throw new RpcUnavailableError(`HTTP ${response.status}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new RpcError("malformed JSON");
      }
      return readSuccess(parsed, id);
    },
  };
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** A result is returned only when the id matches and the body has no error. */
function readSuccess(parsed: unknown, id: number): unknown {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RpcError("malformed JSON-RPC response");
  }
  const record = parsed as Record<string, unknown>;
  if (record.id !== id) {
    throw new RpcError("JSON-RPC id mismatch");
  }
  if ("error" in record && record.error != null) {
    const error = record.error;
    const code =
      error !== null && typeof error === "object" && typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : undefined;
    const message =
      error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "JSON-RPC error";
    throw new RpcError(message, code);
  }
  if (!("result" in record)) {
    throw new RpcError("malformed JSON-RPC response");
  }
  return record.result;
}
