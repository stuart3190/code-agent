const TERMINAL_FAILURES = new Set(["ERROR", "EXPIRED"]);

export async function waitForInstagramContainer({
  containerId,
  token,
  graph,
  fetchFn = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 12,
  delayMs = 5_000,
}) {
  let lastStatus = "UNKNOWN";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const url = new URL(`${graph}/${containerId}`);
    url.search = new URLSearchParams({ fields: "status_code,status", access_token: token });
    const response = await fetchFn(url);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`instagram status: ${JSON.stringify(body.error || body).slice(0, 200)}`);
    }

    lastStatus = String(body.status_code || "UNKNOWN").toUpperCase();
    if (lastStatus === "FINISHED" || lastStatus === "PUBLISHED") return body;
    if (TERMINAL_FAILURES.has(lastStatus)) {
      throw new Error(`instagram container ${lastStatus.toLowerCase()}: ${body.status || "processing failed"}`);
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`instagram container was not ready after ${attempts} checks (last status: ${lastStatus})`);
}
