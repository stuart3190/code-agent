// Drain only an idle, positively identified worker. A concurrent build or operator pause
// postpones deployment instead of terminating work. A fresh heartbeat acknowledges the command.
export async function drainIdleWorker({ registry, pid, hostname, currentPid, stop,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), polls = 30 }) {
  if (!pid) throw new Error("Worker is not running; inspect release state before deployment");
  const nodes = await registry.list();
  const matches = nodes.filter(node => node.metadata?.pid === pid && node.metadata?.hostname === hostname);
  if (matches.length !== 1) throw new Error("Cannot uniquely identify the service worker");
  const node = matches[0];
  if (node.state !== "active" || node.current_job_id) {
    throw new Error("Worker is busy or already under operator control; deployment postponed");
  }
  const started = now();
  try {
    await registry.drain(node.worker_id);
    for (let i = 0; i < polls; i += 1) {
      await sleep(1_000);
      const fresh = await registry.get(node.worker_id);
      if (fresh.current_job_id) throw new Error("A job raced with drain; leave it running and postpone deployment");
      if (fresh.state === "draining" && Date.parse(fresh.heartbeat_at) > started + 500) {
        if (await currentPid() !== pid) throw new Error("Worker process changed during drain");
        await stop();
        return { workerId: node.worker_id, drained: true, stopped: true };
      }
    }
    throw new Error("Worker did not acknowledge drain");
  } catch (error) {
    await registry.resume(node.worker_id);
    throw error;
  }
}
