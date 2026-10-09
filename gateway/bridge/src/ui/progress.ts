/**
 * Progress copy. A step is "done" only when `proven` came back from the
 * tracker in this page session. A stored phase is never treated as current.
 */

import type { BridgeConfig, DepositRecord, Phase } from "../types";
import { el } from "./dom";
import { explorerHref, formatEthLabel, formatTime, observedAt, stepLabel } from "./format";

type StepId = "included" | "received" | "confirmed";
type StepState = "done" | "current" | "pending";

const STEPS: { id: StepId; label: string }[] = [
  { id: "included", label: "Included on Sepolia" },
  { id: "received", label: "Received on ForteL2" },
  { id: "confirmed", label: "Confirmed by replica" },
];

function statesFor(phase: Phase): Record<StepId, StepState> {
  switch (phase) {
    case "l1-pending":
      return { included: "current", received: "pending", confirmed: "pending" };
    case "l1-included":
    case "l2-pending":
      return { included: "done", received: "current", confirmed: "pending" };
    case "l2-received":
      return { included: "done", received: "done", confirmed: "current" };
    case "replica-confirmed":
      return { included: "done", received: "done", confirmed: "done" };
    default:
      return { included: "pending", received: "pending", confirmed: "pending" };
  }
}

function stateWord(state: StepState): string {
  if (state === "done") return "done";
  if (state === "current") return "in progress";
  return "not yet";
}

function addHash(parent: HTMLElement, label: string, hash: string | undefined, template: string): void {
  if (!hash) return;
  const line = el("p", { className: "wrap" });
  line.append(el("span", { text: `${label} ` }));
  const href = explorerHref(template, hash);
  if (href) {
    const link = el("a", { className: "hash", text: hash });
    link.href = href;
    link.rel = "noopener noreferrer";
    line.append(link);
  } else {
    line.append(el("span", { className: "hash", text: hash }));
  }
  parent.append(line);
}

function addObserved(parent: HTMLElement, record: DepositRecord): void {
  const spans: { label: string; start: number | undefined; end: number | undefined }[] = [
    { label: "Included on Sepolia", start: record.approvedAt, end: record.l1IncludedObservedAt },
    { label: "Received on ForteL2", start: record.l1IncludedObservedAt, end: record.l2ObservedAt },
    { label: "Confirmed by replica", start: record.l2ObservedAt, end: record.replicaObservedAt },
  ];
  const shown = spans.filter((span) => span.start !== undefined && span.end !== undefined);
  if (shown.length === 0) return;
  parent.append(el("p", { text: "observed in this browser" }));
  for (const span of shown) {
    const delta = (span.end as number) - (span.start as number);
    parent.append(el("p", { text: `${span.label}: ${delta} ms, observed in this browser` }));
  }
}

export function renderProgressArticle(
  parent: HTMLElement,
  stored: DepositRecord,
  proven: DepositRecord | null,
  cfg: BridgeConfig,
): void {
  const article = el("article", { className: "deposit-article" });
  article.dataset.l1Hash = stored.l1Hash;
  article.dataset.proven = proven ? "true" : "false";

  const phase = proven?.phase;
  const states = phase ? statesFor(phase) : statesFor("disconnected");
  const list = el("ol");
  for (const step of STEPS) {
    const state = states[step.id];
    const item = el("li", {
      className: "step",
      text: `${step.label}: ${stateWord(state)}`,
    });
    item.dataset.step = step.id;
    item.dataset.state = state;
    if (state === "current" && proven) item.setAttribute("aria-current", "step");
    list.append(item);
  }
  article.append(list);

  const view = proven ?? null;
  if (!view) {
    article.append(el("p", { className: "phase", text: "pending" }));
  } else if (view.phase === "tracking-unavailable") {
    const when = observedAt(view);
    const whenText = when === null ? "unknown time" : formatTime(when);
    article.append(
      el("p", {
        className: "phase",
        text: `Last confirmed: ${stepLabel(view.lastProvenPhase)} at ${whenText}. Rechecking…`,
      }),
    );
  } else if (view.phase === "l1-reverted") {
    const fee = view.actualL1FeeWei ? formatEthLabel(view.actualL1FeeWei) : "fee unavailable";
    article.append(el("p", { className: "phase", text: `Sepolia transaction reverted. Actual L1 network fee ${fee}.` }));
  } else if (view.phase === "l2-execution-failed") {
    article.append(el("p", { className: "phase", text: "The recipient did not receive this transfer" }));
    addHash(article, "Sepolia", view.l1Hash, cfg.l1.explorerTx);
    addHash(article, "ForteL2", view.l2Hash, cfg.l2.explorerTx);
    if (view.lastError) article.append(el("p", { className: "error", text: view.lastError }));
  } else if (view.phase === "unsupported-deposit") {
    article.append(el("p", { className: "phase error", text: view.lastError ?? "unsupported deposit" }));
  } else if (view.phase === "replaced" || view.phase === "cancelled") {
    article.append(el("p", { className: "phase", text: view.phase === "replaced" ? "Replaced" : "Cancelled" }));
    addHash(article, "Sepolia", view.l1Hash, cfg.l1.explorerTx);
    addHash(article, "Replaced by", view.replacedBy, cfg.l1.explorerTx);
    addHash(article, "Replaces", view.replaces, cfg.l1.explorerTx);
  } else if (view.phase === "replica-confirmed") {
    article.append(el("p", { className: "phase", text: "The replica returned this deposit. Observed in this browser." }));
    addHash(article, "Sepolia", view.l1Hash, cfg.l1.explorerTx);
    addHash(article, "ForteL2", view.l2Hash, cfg.l2.explorerTx);
  } else {
    article.append(el("p", { className: "phase", text: view.phase }));
    addHash(article, "Sepolia", view.l1Hash, cfg.l1.explorerTx);
    if (view.l2Hash) addHash(article, "ForteL2", view.l2Hash, cfg.l2.explorerTx);
  }

  if (view?.lastError && view.phase !== "unsupported-deposit" && view.phase !== "l2-execution-failed") {
    article.append(el("p", { className: "error", text: view.lastError }));
  }
  if (!view && stored.lastError) {
    article.append(el("p", { className: "error", text: stored.lastError }));
  }
  if (view && view.phase !== "tracking-unavailable") addObserved(article, view);

  parent.append(article);
}

export function historyPhase(proven: DepositRecord | null): string {
  if (!proven) return "pending";
  if (proven.phase === "tracking-unavailable") return "rechecking";
  return proven.phase;
}
