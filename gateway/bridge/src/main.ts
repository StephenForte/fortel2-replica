import { startBridge } from "./ui/app";

function boot(): void {
  void startBridge().catch((err: unknown) => {
    const live = document.getElementById("live");
    const message = err instanceof Error ? err.message : "The bridge could not start.";
    if (live) live.textContent = message;
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
