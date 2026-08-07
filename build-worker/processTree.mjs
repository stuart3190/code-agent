import { spawn } from "node:child_process";

export class ProcessExecutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProcessExecutionError";
    Object.assign(this, details);
  }
}

export async function terminateProcessTree(child, { graceMs = 2_000 } = {}) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore",
      });
      killer.once("exit", resolve); killer.once("error", resolve);
    });
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, graceMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}

export function runProcess(command, args = [], {
  cwd, env = {}, wallMs = 300_000, outputBytes = 4 * 1024 * 1024,
  signal = null, onStdout = null, onStderr = null, spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawnImpl(command, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let total = 0;
    let timedOut = false;
    let cancelled = false;
    let outputLimited = false;
    let settling = false;

    const add = (kind, chunk) => {
      const value = Buffer.from(chunk);
      total += value.length;
      if (total > outputBytes) {
        outputLimited = true;
        terminateProcessTree(child).catch(() => {});
        return;
      }
      if (kind === "stdout") {
        stdout = Buffer.concat([stdout, value]);
        onStdout?.(value.toString("utf8"));
      } else {
        stderr = Buffer.concat([stderr, value]);
        onStderr?.(value.toString("utf8"));
      }
    };
    child.stdout?.on("data", (chunk) => add("stdout", chunk));
    child.stderr?.on("data", (chunk) => add("stderr", chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child).catch(() => {});
    }, Math.max(100, wallMs));
    timeout.unref?.();

    const onAbort = () => {
      cancelled = true;
      terminateProcessTree(child).catch(() => {});
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (fn, value) => {
      if (settling) return;
      settling = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", onAbort);
      fn(value);
    };
    child.once("error", (error) => finish(reject, new ProcessExecutionError(error.message, {
      classification: "spawn_error", cause: error,
    })));
    child.once("exit", (code, exitSignal) => {
      const result = {
        ok: code === 0 && !timedOut && !cancelled && !outputLimited,
        exitCode: code,
        signal: exitSignal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        durationMs: Date.now() - startedAt,
        classification: cancelled ? "cancelled"
          : timedOut ? "timeout"
          : outputLimited ? "output_limit"
          : (code === 137 || exitSignal === "SIGKILL") ? "resource_limit"
          : code === 0 ? null : "exit_code",
      };
      finish(resolve, result);
    });
  });
}

