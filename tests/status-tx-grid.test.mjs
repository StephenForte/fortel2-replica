import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const htmlPath = join(dirname(fileURLToPath(import.meta.url)), "../gateway/status.html");
const html = readFileSync(htmlPath, "utf8");
const START = "/* TX_GRID_LOGIC_START */";
const END = "/* TX_GRID_LOGIC_END */";
const start = html.indexOf(START);
const end = html.indexOf(END);
if (start < 0 || end < start) throw new Error("tx grid logic markers missing");
const logic = html.slice(start + START.length, end);

const api = new Function(
  logic +
    `
return {
  TX_KINDS, TX_SYSTEM_FROM, TX_INITIAL_BLOCKS, TX_INITIAL_ROWS, TX_OLDER_CHUNK,
  TX_BATCH_SIZE, TX_SYSTEM_WINDOW, TX_DOM_CAP, TX_EXPLORER_PREFIX, TX_HASH_RE,
  classifyTx, codeIsPresent, addressesNeedingCode, rowsFromBlocks, chunkList,
  createInitialScan, createOlderScan, runScanLoop, nextBlockBatch, forwardBlockBatch,
  sortRows, toggleSortDir, filterRows, selectRows, emptyMessage, explorerHref,
  formatEth, shortHex, scannedLabel, systemWindowNote, capNote, progressText,
  defaultKinds, inSystemWindow, retainRows,
  shouldRunInitial, settleInitial,
};
`,
)();

function functionBody(source, name) {
  const at = source.indexOf("function " + name);
  assert.ok(at > 0, name);
  const brace = source.indexOf("{", at);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(brace + 1, i);
    }
  }
  throw new Error("unclosed " + name);
}

function row(over) {
  return {
    hash: "0x" + "11".repeat(32),
    kind: "Transfer",
    blockNumber: 1,
    timestamp: 1700000000,
    from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    value: "0x0",
    index: 0,
    ...over,
  };
}

async function drive(scan, nonSystemPerBlock, stopAfterBatches) {
  let batches = 0;
  const blocks = [];
  const sizes = [];
  let fetches = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = () => {
    fetches++;
    return Promise.reject(new Error("fetch"));
  };
  try {
    await api.runScanLoop(scan, {
      stop: () => stopAfterBatches != null && batches >= stopAfterBatches,
      hidden: () => false,
      waitVisible: async () => {},
      async ingest(batch) {
        assert.ok(batch.length <= api.TX_BATCH_SIZE);
        assert.ok(batch.length > 0);
        batches++;
        sizes.push(batch.length);
        blocks.push(...batch);
        let found = 0;
        for (const height of batch) found += nonSystemPerBlock(height);
        return found;
      },
    });
  } finally {
    if (previous === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous;
  }
  assert.equal(fetches, 0);
  return { batches, blocks, sizes, scan };
}

test("page script parses and the logic block does not touch the network or html sinks", () => {
  const script = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(script);
  new Function(script[1]);
  assert.equal(logic.includes("https://settlementos-explorer-ihgo.onrender.com"), false);
  for (const banned of ["fetch(", "rpcBatch", "XMLHttpRequest", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
    assert.equal(logic.includes(banned), false, banned);
  }
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
    assert.equal(html.includes(sink), false, sink);
  }
});

test("classifies each kind, including mixed-case addresses and a null to", () => {
  const sys = api.TX_SYSTEM_FROM;
  const mixedSys = "0x" + "DeAd".repeat(8) + "DeAd0001";
  assert.equal(mixedSys.toLowerCase(), sys);
  assert.equal(sys.slice(2).length, 40);
  assert.equal(api.classifyTx({ type: "0x7e", from: sys, to: "0xabc" }, false), "System");
  assert.equal(api.classifyTx({ type: "0x7E", from: mixedSys, to: null }, true), "System");
  assert.equal(api.classifyTx({ type: 126, from: sys.toUpperCase(), to: "0xAbC" }, false), "System");
  assert.equal(api.classifyTx({
    type: "0x7e",
    from: "0xF8b8b3b58ebac9fc530d9244c22f391e90cc8ae2",
    to: "0x481175bc15ee6e22eab97176540a98ab6a2925ef",
  }, true), "Deposit");
  assert.equal(api.classifyTx({
    type: "0x2",
    from: "0xF8B8B3B58EBAC9FC530D9244C22F391E90CC8AE2",
    to: "0x481175BC15EE6E22EAB97176540A98AB6A2925EF",
  }, true), "dApp call");
  assert.equal(api.classifyTx({
    type: "0x2",
    from: "0xF8B8B3B58EBAC9FC530D9244C22F391E90CC8AE2",
    to: "0x481175BC15EE6E22EAB97176540A98AB6A2925EF",
  }, false), "Transfer");
  assert.equal(api.classifyTx({ type: "0x0", from: "0xabc", to: null }, true), "Contract creation");
  assert.equal(api.classifyTx({ type: "0x2", from: "0xabc" }, false), "Contract creation");
  assert.equal(api.codeIsPresent("0x"), false);
  assert.equal(api.codeIsPresent("0X"), false);
  assert.equal(api.codeIsPresent("0x60806040"), true);

  const codeTo = "0x481175BC15EE6E22EAB97176540A98AB6A2925EF";
  const block = {
    number: "0xa",
    timestamp: "0x65",
    transactions: [
      { hash: "0x" + "aa".repeat(32), type: "0x2", from: "0xABC", to: codeTo, value: "0x0", transactionIndex: "0x0" },
      { hash: "0x" + "bb".repeat(32), type: "0x0", from: "0xABC", to: null, value: "0x1", transactionIndex: "0x1" },
      { hash: "0x" + "cc".repeat(32), type: "0x7e", from: mixedSys, to: "0x4200000000000000000000000000000000000015", value: "0x0", transactionIndex: "0x2" },
    ],
  };
  const rows = api.rowsFromBlocks([block], (key) => key === codeTo.toLowerCase());
  assert.deepEqual(rows.map((r) => r.kind), ["dApp call", "Contract creation", "System"]);

  const cache = new Map([[codeTo.toLowerCase(), true]]);
  const need = api.addressesNeedingCode(block.transactions, cache);
  assert.deepEqual(need, []);
  const fresh = api.addressesNeedingCode(block.transactions, new Map());
  assert.deepEqual(fresh, [codeTo.toLowerCase()]);
});

test("explorer href is the split prefix plus a 32-byte hash", () => {
  const hash = "0x" + "ab".repeat(32);
  const upper = "0x" + "AB".repeat(32);
  assert.equal(api.TX_EXPLORER_PREFIX, "https:" + "//settlementos-explorer-ihgo.onrender.com/fortel2-sepolia/tx/");
  assert.equal(api.explorerHref(hash), api.TX_EXPLORER_PREFIX + hash);
  assert.equal(api.explorerHref(upper), api.TX_EXPLORER_PREFIX + upper);
  assert.equal(api.explorerHref("javascript:alert(1)"), null);
  assert.equal(api.explorerHref(hash + "<img>"), null);
  assert.equal(api.explorerHref("0x1234"), null);
  assert.equal(api.shortHex(hash), hash.slice(0, 10) + "…" + hash.slice(-6));
});

test("sort toggles, is stable, and filter does not call fetch", () => {
  let fetches = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = () => {
    fetches++;
    return Promise.reject(new Error("fetch"));
  };
  try {
    const rows = [
      row({ kind: "Transfer", hash: "0x" + "aa".repeat(32), blockNumber: 3, index: 0, timestamp: 300, from: "0xaaa", to: "0xbbb", value: "0x2" }),
      row({ kind: "Transfer", hash: "0x" + "bb".repeat(32), blockNumber: 3, index: 1, timestamp: 300, from: "0xccc", to: "0xddd", value: "0x1" }),
      row({ kind: "Deposit", hash: "0x" + "cc".repeat(32), blockNumber: 2, index: 0, timestamp: 100, from: "0xAbCdEf", to: "0x111", value: "0x5" }),
    ];
    const before = fetches;
    const desc = api.sortRows(rows, "block", "desc");
    assert.deepEqual(desc.map((r) => r.hash), [rows[1].hash, rows[0].hash, rows[2].hash]);
    const flipped = api.toggleSortDir("block", "desc", "block");
    assert.deepEqual(flipped, { key: "block", dir: "asc" });
    const asc = api.sortRows(rows, flipped.key, flipped.dir);
    assert.deepEqual(asc.map((r) => [r.blockNumber, r.index]), [[2, 0], [3, 0], [3, 1]]);
    const toKind = api.toggleSortDir("block", "asc", "kind");
    assert.deepEqual(toKind, { key: "kind", dir: "desc" });
    const kindAsc = api.sortRows(rows, "kind", "asc");
    assert.equal(kindAsc[0].kind, "Deposit");
    assert.equal(kindAsc[1].hash, rows[0].hash);
    assert.equal(kindAsc[2].hash, rows[1].hash);
    const kindDesc = api.sortRows(rows, "kind", "desc");
    assert.equal(kindDesc[0].hash, rows[0].hash);
    assert.equal(kindDesc[1].hash, rows[1].hash);
    assert.equal(kindDesc[2].kind, "Deposit");
    assert.deepEqual(rows.map((r) => r.hash), [
      "0x" + "aa".repeat(32),
      "0x" + "bb".repeat(32),
      "0x" + "cc".repeat(32),
    ]);

    const kinds = api.defaultKinds();
    assert.equal(kinds.System, false);
    const view = { kinds, query: "abcdef", sortKey: "block", sortDir: "desc" };
    const filtered = api.selectRows(rows, view, 3);
    assert.equal(filtered.rows.length, 1);
    assert.equal(filtered.rows[0].kind, "Deposit");
    view.query = "no-such-tx";
    assert.equal(api.selectRows(rows, view, 3).rows.length, 0);
    assert.equal(fetches, before);
  } finally {
    if (previous === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous;
  }
});

test("filter and sort handlers do not call rpc", () => {
  for (const name of ["onTxFilter", "onTxKind", "onTxSort", "renderTxBody"]) {
    const body = functionBody(html, name);
    assert.equal(/fetch|rpcBatch|XMLHttpRequest|eth_get/.test(body), false, name);
  }
  const follow = functionBody(html, "txFollowHead");
  assert.match(follow, /forwardBlockBatch/);
  assert.equal(/\bwhile\b/.test(follow), false);
});

test("system rows stay inside the newest 200 blocks and the dom cap is 1000", () => {
  const kinds = api.defaultKinds();
  kinds.System = true;
  const rows = [
    row({ kind: "System", blockNumber: 1000, hash: "0x" + "01".repeat(32) }),
    row({ kind: "System", blockNumber: 801, hash: "0x" + "02".repeat(32) }),
    row({ kind: "System", blockNumber: 800, hash: "0x" + "03".repeat(32) }),
    row({ kind: "Transfer", blockNumber: 1, hash: "0x" + "04".repeat(32) }),
  ];
  const view = api.selectRows(rows, { kinds, query: "", sortKey: "block", sortDir: "desc" }, 1000);
  assert.deepEqual(view.rows.map((r) => r.blockNumber), [1000, 801, 1]);
  assert.match(api.systemWindowNote(true), /newest 200 scanned blocks/);
  assert.equal(api.systemWindowNote(false), "");

  const many = [];
  for (let i = 0; i < 1001; i++) {
    many.push(row({
      kind: "Transfer",
      blockNumber: i,
      index: 0,
      hash: "0x" + i.toString(16).padStart(64, "0"),
    }));
  }
  const capped = api.selectRows(many, { kinds: api.defaultKinds(), query: "", sortKey: "block", sortDir: "desc" }, 5000);
  assert.equal(capped.rows.length, 1000);
  assert.equal(capped.matched, 1001);
  assert.equal(capped.capped, true);
  assert.equal(capped.rows[0].blockNumber, 1000);
  assert.equal(api.capNote(1001, true), "Showing the first 1,000 of 1,001 matching rows.");
  assert.equal(api.retainRows(rows, 1000).some((r) => r.blockNumber === 800), false);
});

test("empty copy names the scanned range", () => {
  const onlyDapp = { "dApp call": true };
  assert.equal(
    api.emptyMessage(onlyDapp, "", 2286253, 2292975),
    "No dApp calls in blocks 2,286,253–2,292,975. Scan older to look further back.",
  );
  assert.equal(
    api.emptyMessage(api.defaultKinds(), "  AbC ", 1, 2),
    'No transactions matching "AbC" in blocks 1–2. Scan older to look further back.',
  );
  assert.equal(api.scannedLabel(10, 20), "blocks 10–20 scanned");
  assert.equal(api.formatEth("0x11c37937e08000"), "0.005");
  assert.equal(api.formatEth("0x0"), "0");
  assert.equal(api.progressText("older", 1200, 5000, 2), "Scanning older… 1,200 / 5,000 blocks · 2 non-system rows");
});

test("initial scan stops at 25 non-system rows or 2000 blocks", async () => {
  const empty = await drive(api.createInitialScan(100000), () => 0);
  assert.equal(empty.blocks.length, api.TX_INITIAL_BLOCKS);
  assert.equal(empty.batches, 20);
  assert.deepEqual(empty.sizes, Array(20).fill(100));
  assert.equal(empty.blocks[0], 100000);
  assert.equal(empty.blocks[1999], 98001);

  const dense = await drive(api.createInitialScan(100000), () => 1);
  assert.equal(dense.batches, 1);
  assert.equal(dense.blocks.length, 100);
  assert.ok(dense.scan.rows >= api.TX_INITIAL_ROWS);

  const tiny = await drive(api.createInitialScan(10), () => 0);
  assert.deepEqual(tiny.blocks, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  assert.deepEqual(tiny.sizes, [11]);
});

test("one Scan older click requests 5000 blocks in batches of at most 100", async () => {
  const older = await drive(api.createOlderScan(80000), () => 0);
  assert.equal(older.blocks.length, 5000);
  assert.equal(older.batches, 50);
  assert.deepEqual(older.sizes, Array(50).fill(100));
  assert.equal(Math.max(...older.sizes) <= 100, true);
  assert.equal(older.blocks[0], 79999);
  assert.equal(older.blocks[older.blocks.length - 1], 75000);

  const near = await drive(api.createOlderScan(250), () => 0);
  assert.deepEqual(near.sizes, [100, 100, 50]);
  assert.equal(near.blocks.length, 250);
  assert.equal(near.blocks[0], 249);
  assert.equal(near.blocks[near.blocks.length - 1], 0);

  const tail = await drive(api.createOlderScan(30), () => 0);
  assert.deepEqual(tail.sizes, [30]);
  assert.equal(tail.blocks[0], 29);
  assert.equal(tail.blocks[tail.blocks.length - 1], 0);
  assert.equal(api.createOlderScan(0), null);

  const stopped = await drive(api.createOlderScan(10000), () => 0, 1);
  assert.equal(stopped.batches, 1);
  assert.equal(stopped.blocks.length, 100);
  assert.equal(stopped.blocks[0], 9999);
});

test("a failed initial scan retries, and stop does not stick", () => {
  const failed = {
    newest: null, oldest: null, initialSkipped: false, stop: false,
    started: false, mode: "initial", progress: "scanning",
  };
  api.settleInitial(failed, 100, false);
  assert.equal(failed.stop, false);
  assert.equal(failed.newest, null);
  assert.equal(failed.initialSkipped, false);
  assert.equal(api.shouldRunInitial(failed), true);
  assert.deepEqual(api.forwardBlockBatch(failed.newest, 100, 100), []);

  const halted = {
    newest: null, oldest: null, initialSkipped: false, stop: true,
    started: false, mode: "initial", progress: "scanning",
  };
  api.settleInitial(halted, 100, true);
  assert.equal(halted.stop, false);
  assert.equal(halted.initialSkipped, true);
  assert.equal(halted.oldest, 101);
  assert.equal(halted.started, true);
  assert.equal(api.shouldRunInitial(halted), false);

  const partial = {
    newest: 90, oldest: 80, initialSkipped: false, stop: true,
    started: true, mode: "older", progress: "scanning", error: "Replica returned / HTTP 429",
  };
  api.settleInitial(partial, 100, true);
  assert.equal(partial.stop, false);
  assert.equal(partial.newest, 90);
  assert.equal(partial.error, "Replica returned / HTTP 429");
  assert.equal(api.shouldRunInitial(partial), false);
  assert.match(functionBody(html, "txFollowHead"), /TX\.error = null/);
  assert.match(functionBody(html, "runOlder"), /TX\.stop = false/);
});

test("head follow requests at most one batch and code lookups are chunked at 100", () => {
  assert.deepEqual(api.forwardBlockBatch(100, 103, 100), [101, 102, 103]);
  const gap = api.forwardBlockBatch(100, 250, 100);
  assert.equal(gap.length, 100);
  assert.equal(gap[0], 101);
  assert.equal(gap[99], 200);
  assert.deepEqual(api.forwardBlockBatch(100, 100, 100), []);
  const addrs = Array.from({ length: 250 }, (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"));
  assert.deepEqual(api.chunkList(addrs, 100).map((part) => part.length), [100, 100, 50]);
});
