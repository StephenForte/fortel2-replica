/**
 * EIP-1193 provider double for bridge tests. Records every request and
 * emits the events MetaMask uses. B6 reuses this module.
 */

export type RecordedRequest = {
  method: string;
  params: unknown;
};

/** `callIndex` is 1 for the first call of that method. */
export type MockHandler = (params: unknown, callIndex: number) => unknown | Promise<unknown>;

export type MockEip1193 = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  listenerCount(event?: string): number;
  readonly requests: readonly RecordedRequest[];
  calls(method: string): readonly RecordedRequest[];
  handle(method: string, handler: MockHandler): void;
  isMetaMask: boolean;
  isBraveWallet: boolean;
  providers?: MockEip1193[];
};

export function createMockEip1193(options?: {
  isMetaMask?: boolean;
  isBraveWallet?: boolean;
}): MockEip1193 {
  const requests: RecordedRequest[] = [];
  const handlers = new Map<string, MockHandler>();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const provider: MockEip1193 = {
    isMetaMask: options?.isMetaMask ?? true,
    isBraveWallet: options?.isBraveWallet ?? false,
    requests,
    calls(method: string): readonly RecordedRequest[] {
      return requests.filter((entry) => entry.method === method);
    },
    handle(method: string, handler: MockHandler): void {
      handlers.set(method, handler);
    },
    async request(args: { method: string; params?: unknown }): Promise<unknown> {
      const params = cloneParams(args.params);
      requests.push({ method: args.method, params });
      const handler = handlers.get(args.method);
      if (!handler) {
        throw new Error(`unexpected ethereum request: ${args.method}`);
      }
      const callIndex = requests.filter((entry) => entry.method === args.method).length;
      return await handler(params, callIndex);
    },
    on(event: string, listener: (...args: unknown[]) => void): void {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    removeListener(event: string, listener: (...args: unknown[]) => void): void {
      const list = listeners.get(event);
      if (!list) return;
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    emit(event: string, ...args: unknown[]): void {
      const list = [...(listeners.get(event) ?? [])];
      for (const listener of list) listener(...args);
    },
    listenerCount(event?: string): number {
      if (event === undefined) {
        let total = 0;
        for (const list of listeners.values()) total += list.length;
        return total;
      }
      return listeners.get(event)?.length ?? 0;
    },
  };

  return provider;
}

function cloneParams(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}
