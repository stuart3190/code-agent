function parseDeadline(value, fallback) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function confirmedLeaseLoss(error) {
  return error?.code === "40001" || /lease lost/i.test(String(error?.message || error));
}

function leaseLost(cause) {
  return Object.assign(new Error("lease lost"), { code: "lease_lost", cause });
}

/**
 * Renew one durable worker lease without allowing a slow upstream request to consume the lease.
 * Transient transport failures retry while the last confirmed lease is valid. A database-confirmed
 * loss, or reaching that durable deadline without a successful renewal, still fails closed.
 */
export function startWorkerLeaseHeartbeat({
  renew,
  initialLeaseExpiresAt,
  leaseSeconds,
  onState,
  onTransientError = () => {},
  onLeaseLost,
  now = Date.now,
  intervalMs = Math.max(5_000, Math.floor(leaseSeconds * 1_000 / 3)),
  retryMs = 1_000,
  requestTimeoutMs = Math.min(5_000, Math.max(1_000, Math.floor(intervalMs / 3))),
}) {
  let stopped = false;
  let timer = null;
  let deadline = parseDeadline(initialLeaseExpiresAt, now() + leaseSeconds * 1_000);

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const failClosed = (error) => {
    stop();
    onLeaseLost(leaseLost(error));
  };

  const schedule = (delayMs) => {
    if (stopped) return;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      failClosed(new Error("durable lease renewal deadline elapsed"));
      return;
    }
    timer = setTimeout(tick, Math.max(0, Math.min(delayMs, remainingMs)));
    timer.unref?.();
  };

  const tick = async () => {
    timer = null;
    if (stopped) return;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      failClosed(new Error("durable lease renewal deadline elapsed"));
      return;
    }
    try {
      const signal = AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remainingMs)));
      const state = await renew({ signal });
      if (stopped) return;
      deadline = parseDeadline(state?.lease_expires_at, now() + leaseSeconds * 1_000);
      onState(state);
      schedule(intervalMs);
    } catch (error) {
      if (stopped) return;
      if (confirmedLeaseLoss(error) || now() >= deadline) {
        failClosed(error);
        return;
      }
      onTransientError(error, { leaseExpiresAt: new Date(deadline).toISOString() });
      schedule(retryMs);
    }
  };

  schedule(intervalMs);
  return { stop };
}
