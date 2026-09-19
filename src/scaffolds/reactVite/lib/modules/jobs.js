// Jobs, usage and scheduled actions module v1 — platform infrastructure, do not edit.
//
// Long-running work already has a queue, a job table and a usage balance. What generated code
// wrote around them is what the audit asks to remove (§7.1, WP13 "replaces polling/job
// controllers" and "scheduling mechanics"):
//
//   - POLLING AT A FIXED INTERVAL, forever. A `setInterval(check, 1500)` that never stopped when
//     the screen unmounted, never backed off, and counted a network blip as a failure. Waiting
//     here prefers the live subscription and falls back to polling with backoff and a deadline.
//   - DOUBLE INVOCATION. A double-clicked button started two jobs, and a retried effect started a
//     third. An idempotency key derived from the action and its input makes those one job.
//   - QUOTA AS A SURPRISE. Work started, ran, and failed at settlement because the balance was
//     never checked. The balance is checked before dispatch, and the refusal names the shortfall.
//   - SCHEDULES THAT DOUBLE-FIRE. Two workers picking up the same due schedule ran it twice.
//     An occurrence key — the schedule plus the exact slot it is for — makes a repeat a no-op.
//
// Headless: state and functions only.

export const JOBS_MODULE_VERSION = "1.0.0";

export const JOB_STATUS = Object.freeze({
  QUEUED: "queued", RUNNING: "running", SUCCEEDED: "succeeded", FAILED: "failed", CANCELLED: "cancelled",
});
const TERMINAL = new Set([JOB_STATUS.SUCCEEDED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED]);

export const JOB_ERROR = Object.freeze({
  UNKNOWN_ACTION: "job_action_unknown",
  INPUT_INVALID: "job_input_invalid",
  QUOTA_EXCEEDED: "job_quota_exceeded",
  NOT_CANCELLABLE: "job_not_cancellable",
  TIMEOUT: "job_wait_timeout",
  UNAVAILABLE: "jobs_unavailable",
});

export class JobError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const freeze = (value) => Object.freeze(value);
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * Compile the declared actions.
 *   actions: [{ id, provider, operation, inputs: ["prompt"], cost?, grant? }]
 * An action the contract never declared cannot be invoked, which is what stops a generated screen
 * from inventing a provider call nobody priced.
 */
export function compileActions(actions = []) {
  const definitions = {};
  for (const row of listOf(actions)) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    definitions[id] = freeze({
      id,
      actionKey: String(row?.actionKey || row?.id),
      provider: row?.provider ? String(row.provider) : null,
      operation: row?.operation ? String(row.operation) : null,
      inputs: freeze(listOf(row?.inputs).map(String)),
      required: freeze(listOf(row?.required ?? row?.inputs).map(String)),
      cost: Number(row?.cost) > 0 ? Number(row.cost) : 0,
      grant: row?.grant ? String(row.grant) : null,
    });
  }
  return freeze({ version: JOBS_MODULE_VERSION, definitions: freeze(definitions), ids: freeze(Object.keys(definitions)) });
}

/**
 * A deterministic idempotency key: the same action with the same input is the same job. This is
 * what makes a double-clicked button, a retried effect and a replayed queue message one job
 * rather than three charges.
 */
export function idempotencyKeyFor(actionId, input = {}, salt = null) {
  const canonical = JSON.stringify(input, Object.keys(input || {}).sort());
  let hash = 2166136261;
  for (const text of [String(actionId), canonical, String(salt || "")]) {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }
  return `${actionId}-${hash.toString(36)}`;
}

/** Only the declared inputs, and every required one present. */
export function validateActionInput(definition, input = {}) {
  const missing = definition.required.filter((field) => {
    const value = input?.[field];
    return value === undefined || value === null || String(value).trim() === "";
  });
  const unknown = Object.keys(input || {}).filter((field) => !definition.inputs.includes(field));
  return { ok: missing.length === 0, missing, unknown, input: Object.fromEntries(definition.inputs.map((field) => [field, input?.[field]]).filter(([, value]) => value !== undefined)) };
}

/**
 * @param {object} options
 * @param {object} options.actions compileActions() output
 * @param {object} options.transport the SDK actions surface { invoke, getJob, listJobs, cancel, subscribe }
 * @param {object} [options.usage] { getBalance() }
 * @param {(grant: string) => Promise<boolean>} [options.authorize]
 */
export function createJobs({ actions, transport, usage = null, authorize = null, now = () => Date.now() } = {}) {
  if (!actions?.definitions) throw new JobError(JOB_ERROR.UNAVAILABLE, "createJobs needs a compiled action catalogue");
  if (typeof transport?.invoke !== "function") throw new JobError(JOB_ERROR.UNAVAILABLE, "createJobs needs the actions transport");
  const listeners = new Set();
  let state = { status: "idle", jobs: {}, error: null, balance: null };
  let snapshot = null;
  const emit = () => { for (const listener of [...listeners]) listener(getState()); };
  const commit = (patch) => { state = { ...state, ...patch }; snapshot = null; emit(); return getState(); };
  const getState = () => {
    if (!snapshot) snapshot = freeze({ ...state, jobs: freeze({ ...state.jobs }) });
    return snapshot;
  };
  const record = (job) => (job?.id ? commit({ jobs: { ...state.jobs, [job.id]: job } }) : getState());
  const definitionFor = (actionId) => {
    const definition = actions.definitions[actionId];
    if (!definition) {
      throw new JobError(JOB_ERROR.UNKNOWN_ACTION, `no action "${actionId}" is declared for this application`, { actions: [...actions.ids] });
    }
    return definition;
  };

  return {
    actions,
    getState,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    idempotencyKeyFor,

    /**
     * Start one declared action. The balance is checked BEFORE dispatch, so a quota refusal
     * arrives before the work rather than at settlement.
     */
    async invoke(actionId, input = {}, { idempotencyKey = null, salt = null } = {}) {
      const definition = definitionFor(actionId);
      if (definition.grant && authorize && (await authorize(definition.grant)) === false) {
        return { ok: false, reason: "forbidden", action: actionId };
      }
      const validated = validateActionInput(definition, input);
      if (!validated.ok) {
        return { ok: false, reason: JOB_ERROR.INPUT_INVALID, missing: validated.missing, action: actionId };
      }
      if (definition.cost > 0 && usage?.getBalance) {
        const balance = Number(await usage.getBalance().catch(() => null));
        commit({ balance: Number.isFinite(balance) ? balance : null });
        if (Number.isFinite(balance) && balance < definition.cost) {
          return { ok: false, reason: JOB_ERROR.QUOTA_EXCEEDED, action: actionId, required: definition.cost, balance };
        }
      }
      const key = idempotencyKey || idempotencyKeyFor(actionId, validated.input, salt);
      try {
        const job = await transport.invoke(definition.actionKey, validated.input, { idempotencyKey: key });
        record({ ...job, action: actionId, idempotencyKey: key });
        return { ok: true, job: { ...job, action: actionId, idempotencyKey: key }, idempotencyKey: key };
      } catch (error) {
        commit({ error: { code: JOB_ERROR.UNAVAILABLE, message: String(error?.message || error) } });
        return { ok: false, reason: JOB_ERROR.UNAVAILABLE, action: actionId };
      }
    },

    async get(jobId) {
      const job = await transport.getJob(jobId);
      record(job);
      return job;
    },

    /** Cancel. A job that already finished cannot be cancelled, and saying so is not a failure. */
    async cancel(jobId) {
      // Ask before refusing: a job this controller has never seen may already have finished, and
      // "cannot cancel" is only true of a state that was actually checked.
      const known = state.jobs[jobId] || await transport.getJob(jobId).catch(() => null);
      if (known) record(known);
      if (known && TERMINAL.has(known.status)) {
        return { ok: false, reason: JOB_ERROR.NOT_CANCELLABLE, status: known.status };
      }
      try {
        const job = await transport.cancel(jobId);
        record(job);
        return { ok: true, job };
      } catch (error) {
        return { ok: false, reason: JOB_ERROR.UNAVAILABLE, message: String(error?.message || error) };
      }
    },

    /**
     * Wait for a terminal state. Prefers the live subscription; falls back to polling with
     * BACKOFF and a deadline, and always releases what it opened.
     */
    async wait(jobId, { timeout = 15 * 60_000, interval = 1000, maxInterval = 15_000 } = {}) {
      const deadline = now() + timeout;
      const first = await transport.getJob(jobId);
      record(first);
      if (TERMINAL.has(first?.status)) return { ok: true, job: first };

      if (typeof transport.subscribe === "function") {
        const live = await new Promise((resolve) => {
          let release = null;
          const timer = setTimeout(() => { release?.(); resolve(null); }, Math.max(0, deadline - now()));
          try {
            release = transport.subscribe(jobId, (job) => {
              record(job);
              if (TERMINAL.has(job?.status)) {
                clearTimeout(timer);
                release?.();
                resolve(job);
              }
            });
          } catch {
            clearTimeout(timer);
            resolve(null);
          }
        });
        if (live) return { ok: true, job: live };
      }

      // Backoff, because a fixed interval against a slow job is a self-inflicted load test.
      let wait = interval;
      while (now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        const job = await transport.getJob(jobId).catch(() => null);
        if (job) record(job);
        if (job && TERMINAL.has(job.status)) return { ok: true, job };
        wait = Math.min(maxInterval, Math.round(wait * 1.6));
      }
      return { ok: false, reason: JOB_ERROR.TIMEOUT, jobId, state: getState() };
    },

    async balance() {
      if (!usage?.getBalance) return null;
      const value = Number(await usage.getBalance());
      commit({ balance: Number.isFinite(value) ? value : null });
      return state.balance;
    },
  };
}

// ── scheduled actions ────────────────────────────────────────────────────────

export const SCHEDULE_ERROR = Object.freeze({
  UNKNOWN_SCHEDULE: "schedule_unknown",
  INVALID_CADENCE: "schedule_cadence_invalid",
  UNAVAILABLE: "schedules_unavailable",
});

export const CADENCES = Object.freeze(["hourly", "daily", "weekly", "monthly"]);

/**
 * The exact slot a schedule is due for, as a stable string. Deduplication depends on it: two
 * workers picking up the same due schedule compute the SAME occurrence key, so the second run is
 * a no-op rather than a second charge.
 *
 * Time zones are honoured by offset minutes, because a "daily at 09:00" schedule that drifts an
 * hour twice a year is a schedule nobody trusts.
 */
export function occurrenceKey(schedule, at = new Date(), { offsetMinutes = 0 } = {}) {
  const local = new Date(at.getTime() + offsetMinutes * 60_000);
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  const hour = String(local.getUTCHours()).padStart(2, "0");
  const id = String(schedule?.id || schedule);
  switch (schedule?.cadence) {
    case "hourly": return `${id}@${year}-${month}-${day}T${hour}`;
    case "weekly": {
      const monday = new Date(Date.UTC(year, local.getUTCMonth(), local.getUTCDate() - ((local.getUTCDay() + 6) % 7)));
      return `${id}@${monday.toISOString().slice(0, 10)}`;
    }
    case "monthly": return `${id}@${year}-${month}`;
    default: return `${id}@${year}-${month}-${day}`;
  }
}

/** Is this schedule due at this moment, given when it last ran? */
export function isDue(schedule, at = new Date(), { offsetMinutes = 0 } = {}) {
  if (schedule?.paused === true) return false;
  const local = new Date(at.getTime() + offsetMinutes * 60_000);
  const [hour, minute] = String(schedule?.atTime || "00:00").split(":").map((value) => Number(value) || 0);
  if (schedule?.cadence !== "hourly") {
    if (local.getUTCHours() < hour || (local.getUTCHours() === hour && local.getUTCMinutes() < minute)) return false;
    if (schedule?.cadence === "weekly" && Number(schedule?.weekday ?? 1) !== local.getUTCDay()) return false;
    if (schedule?.cadence === "monthly" && Number(schedule?.dayOfMonth ?? 1) !== local.getUTCDate()) return false;
  }
  return occurrenceKey(schedule, at, { offsetMinutes }) !== schedule?.lastOccurrence;
}

/**
 * @param {object} options
 * @param {object[]} options.schedules declared schedules
 * @param {object} options.storage { list(), put(row) } — where run marks are recorded
 * @param {object} options.jobs a createJobs() controller
 */
export function createSchedules({ schedules = [], storage, jobs, offsetMinutes = 0, now = () => new Date() } = {}) {
  const declared = new Map(listOf(schedules)
    .filter((row) => row?.id && CADENCES.includes(row?.cadence))
    .map((row) => [String(row.id), freeze({ ...row, id: String(row.id) })]));
  if (listOf(schedules).some((row) => row?.cadence && !CADENCES.includes(row.cadence))) {
    throw new JobError(SCHEDULE_ERROR.INVALID_CADENCE, `a schedule cadence must be one of ${CADENCES.join(", ")}`);
  }
  if (!storage?.list) throw new JobError(SCHEDULE_ERROR.UNAVAILABLE, "createSchedules needs schedule storage");

  const stateOf = async (id) => (await storage.list()).find((row) => row.id === id) || null;
  const setPaused = async (id, paused) => {
    if (!declared.has(String(id))) throw new JobError(SCHEDULE_ERROR.UNKNOWN_SCHEDULE, `no schedule "${id}" is declared`);
    const row = (await stateOf(String(id))) || { id: String(id) };
    await storage.put({ ...row, paused });
    return { ok: true, id: String(id), paused };
  };

  return {
    declared: freeze([...declared.values()]),

    async list() {
      const stored = await storage.list();
      return freeze([...declared.values()].map((schedule) => {
        const row = stored.find((candidate) => candidate.id === schedule.id) || {};
        return freeze({ ...schedule, paused: row.paused === true, lastOccurrence: row.lastOccurrence || null, lastRunAt: row.lastRunAt || null });
      }));
    },

    async pause(id) { return setPaused(id, true); },
    async resume(id) { return setPaused(id, false); },

    /**
     * Run everything due. A schedule that already ran for this occurrence is skipped, so two
     * workers reaching this at the same moment produce one run between them.
     */
    async runDue({ at = now() } = {}) {
      const ran = [];
      for (const schedule of await this.list()) {
        if (!isDue(schedule, at, { offsetMinutes })) { ran.push({ id: schedule.id, outcome: schedule.paused ? "paused" : "not_due" }); continue; }
        const occurrence = occurrenceKey(schedule, at, { offsetMinutes });
        // Claim the occurrence BEFORE dispatching. Claiming after would leave the window that
        // lets two workers both dispatch.
        const current = await stateOf(schedule.id);
        if (current?.lastOccurrence === occurrence) { ran.push({ id: schedule.id, outcome: "already_ran", occurrence }); continue; }
        await storage.put({ ...(current || { id: schedule.id }), lastOccurrence: occurrence, lastRunAt: at.toISOString() });
        const result = await jobs.invoke(schedule.action, schedule.input || {}, { idempotencyKey: occurrence });
        ran.push({ id: schedule.id, outcome: result.ok ? "ran" : "refused", occurrence, reason: result.reason || null, job: result.job?.id || null });
      }
      return freeze(ran);
    },
  };
}
