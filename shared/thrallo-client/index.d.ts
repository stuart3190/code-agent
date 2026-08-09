export type HostCapability =
  | "localFilesystem"
  | "localTerminal"
  | "localGit"
  | "cloudWorkspace"
  | "managedBuild"
  | "builderV2Mutation"
  | "preview"
  | "browserDiagnostics"
  | "publishing"
  | "integrations"
  | "nativeKeychain"
  | "nativeUpdates";

export type HostCapabilities = Readonly<Record<HostCapability, boolean>>;
export type ProviderInput = Readonly<Record<string, unknown>> & { signal?: AbortSignal; cursor?: string | null };

export interface ProviderSuccess<T = unknown> {
  readonly ok: true;
  readonly requestId: string;
  readonly data: T;
  readonly observedAt: string | null;
  readonly source: "fixture" | "http" | string;
  readonly revision: string | null;
}

export interface ProviderFailure {
  readonly ok: false;
  readonly requestId: string | null;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | null;
}

export type ProviderResult<T = unknown> = ProviderSuccess<T> | ProviderFailure;

export interface StreamEvent<T = unknown> {
  readonly streamId?: string;
  readonly sequence?: number;
  readonly eventId?: string;
  readonly id?: string | null;
  readonly cursor?: string | null;
  readonly type: string;
  readonly occurredAt?: string;
  readonly payload?: T;
  readonly data?: T;
  readonly terminal?: boolean;
  readonly retry?: number | null;
}

export type ProviderMethod<T = unknown> = (input?: ProviderInput) => Promise<ProviderResult<T>>;
export type ProviderStream<T = unknown> = (input?: ProviderInput) => AsyncIterable<StreamEvent<T>>;

export interface ProjectCatalogueProvider {
  listProjects: ProviderMethod;
  getProject: ProviderMethod;
  createProject: ProviderMethod;
  importProject: ProviderMethod;
  archiveProject: ProviderMethod;
  restoreProject: ProviderMethod;
}

export interface ConversationEventsProvider {
  getConversation: ProviderMethod;
  listTurns: ProviderMethod;
  subscribeConversation: ProviderStream;
  sendInstruction: ProviderMethod;
  cancelTurn: ProviderMethod;
}

export interface PlanDecisionsProvider {
  getPlan: ProviderMethod;
  subscribePlan: ProviderStream;
  approvePlan: ProviderMethod;
  rejectPlan: ProviderMethod;
  requestPlanChanges: ProviderMethod;
}

export interface AgentRunsProvider {
  listAgents: ProviderMethod;
  getRun: ProviderMethod;
  subscribeRun: ProviderStream;
  startRun: ProviderMethod;
  cancelRun: ProviderMethod;
  retryRun: ProviderMethod;
}

export interface ModelsUsageProvider {
  listModels: ProviderMethod;
  getUsage: ProviderMethod;
  getBudget: ProviderMethod;
  selectModel: ProviderMethod;
}

export interface BuildRepairVerificationProvider {
  getBuild: ProviderMethod;
  subscribeBuild: ProviderStream;
  startBuild: ProviderMethod;
  startRepair: ProviderMethod;
  cancelBuild: ProviderMethod;
}

export interface SnapshotsWorkingSetsProvider {
  listSnapshots: ProviderMethod;
  getSnapshot: ProviderMethod;
  createWorkingSet: ProviderMethod;
  checkpointWorkingSet: ProviderMethod;
  applyWorkingSet: ProviderMethod;
  resolveConflict: ProviderMethod;
}

export interface PreviewBrowserTestingProvider {
  getPreview: ProviderMethod;
  subscribeDiagnostics: ProviderStream;
  startTestSession: ProviderMethod;
  cancelTestSession: ProviderMethod;
}

export interface DeploymentsPublishingProvider {
  listDeployments: ProviderMethod;
  getDeployment: ProviderMethod;
  getDomainStatus: ProviderMethod;
  publish: ProviderMethod;
  updateRelease: ProviderMethod;
  rollback: ProviderMethod;
  unpublish: ProviderMethod;
  connectDomain: ProviderMethod;
}

export interface SecretsDatabaseIntegrationsProvider {
  listIntegrationStates: ProviderMethod;
  listSecretNames: ProviderMethod;
  getDatabaseSummary: ProviderMethod;
  setSecret: ProviderMethod;
  connectIntegration: ProviderMethod;
  applyDatabaseChange: ProviderMethod;
}

export interface ThralloProviderSuite {
  readonly projects: ProjectCatalogueProvider;
  readonly conversations: ConversationEventsProvider;
  readonly plans: PlanDecisionsProvider;
  readonly agents: AgentRunsProvider;
  readonly models: ModelsUsageProvider;
  readonly builds: BuildRepairVerificationProvider;
  readonly snapshots: SnapshotsWorkingSetsProvider;
  readonly preview: PreviewBrowserTestingProvider;
  readonly deployments: DeploymentsPublishingProvider;
  readonly integrations: SecretsDatabaseIntegrationsProvider;
}

export interface FixtureCall {
  readonly sequence: number;
  readonly familyId: string;
  readonly operationId: string;
  readonly kind: "read" | "stream" | "mutation";
  readonly requestId: string;
  readonly observedAt: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface FixtureProviderSuite extends ThralloProviderSuite {
  readonly contractVersion: "1.0";
  readonly source: "fixture";
  readonly seed: string;
  readonly scenario: string;
  readonly capabilities: HostCapabilities;
  getCalls(): readonly FixtureCall[];
  getState(): Readonly<{ stateRevision: number; callSequence: number }>;
}

export interface FixtureProviderOptions {
  seed?: string;
  scenario?:
    | "idle"
    | "running"
    | "success"
    | "failure"
    | "cancellation"
    | "recovery"
    | "waiting-approval"
    | "budget-warning"
    | "unsupported-capability"
    | "conflict"
    | "offline-reconnect"
    | "expired-session";
  capabilities?: Partial<HostCapabilities>;
}

export function createFixtureProviderSuite(options?: FixtureProviderOptions): FixtureProviderSuite;
export const FIXTURE_SCENARIO_NAMES: readonly FixtureProviderOptions["scenario"][];
export const DEFAULT_FIXTURE_SEED: string;
export const FIXTURE_CLOCK: string;

export interface RequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  idempotent?: boolean;
  operationId?: string | null;
}

export interface EventStreamOptions {
  path: string;
  cursor?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  operationId?: string | null;
}

export interface ThralloTransport {
  request<T = unknown>(options: RequestOptions): Promise<ProviderSuccess<T>>;
  openEventStream(options: EventStreamOptions): Promise<{ requestId: string; chunks: ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array> }>;
  readonly retryPolicy: Readonly<Record<string, unknown>>;
}

export interface HttpTransportOptions {
  baseUrl: string;
  authProvider?: ((context: { requestId: string; operationId: string | null; signal?: AbortSignal }) => Promise<Record<string, string>> | Record<string, string>) | {
    getAuthHeaders(context: { requestId: string; operationId: string | null; signal?: AbortSignal }): Promise<Record<string, string>> | Record<string, string>;
  };
  fetchImpl?: typeof fetch;
  requestIdFactory?: () => string;
  retryPolicy?: Partial<{ maxAttempts: number; baseDelayMs: number; maxDelayMs: number; retryStatuses: readonly number[] }>;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  logger?: (event: Readonly<Record<string, unknown>>) => void;
}

export function createHttpTransport(options: HttpTransportOptions): ThralloTransport;
export function createStableReadOnlyProvider<K extends keyof ThralloProviderSuite>(options: {
  providerKey: K;
  transport: ThralloTransport;
  operationMap?: Record<string, { method?: "GET" | "HEAD"; path: string | ((input: ProviderInput) => string); headers?: Record<string, string> }>;
}): ThralloProviderSuite[K];

export function createHostCapabilities(overrides?: Partial<HostCapabilities>): HostCapabilities;
export function negotiateCapabilities(offered: Partial<HostCapabilities>, required?: readonly HostCapability[]): Readonly<{
  compatible: boolean;
  required: readonly HostCapability[];
  missing: readonly HostCapability[];
  offered: HostCapabilities;
}>;
export function capabilityUnavailableResult(options?: { capability?: string; operationId?: string; requestId?: string | null }): ProviderFailure;

export class ThralloClientError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details: unknown;
  toJSON(): Record<string, unknown>;
}
export class CapabilityUnavailableError extends ThralloClientError {}
export class AuthenticationExpiredError extends ThralloClientError {}
export class OfflineError extends ThralloClientError {}
export class ConflictError extends ThralloClientError {}
export class CancelledError extends ThralloClientError {}

export function parseSseChunks(source: ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array>): AsyncIterable<StreamEvent>;
export function consumeEventStream(options: {
  connect(context: { cursor: string | null; signal: AbortSignal | null; attempt: number }): Promise<unknown> | unknown;
  initialCursor?: string | null;
  signal?: AbortSignal | null;
  maxReconnects?: number;
  reconnectDelayMs?: number;
  sleep?: (delayMs: number, signal?: AbortSignal | null) => Promise<void>;
}): AsyncIterable<StreamEvent>;

export const CLIENT_CONTRACT_VERSION: "1.0";
export const HOST_CAPABILITY_KEYS: readonly HostCapability[];
export const PROVIDER_FAMILIES: Readonly<Record<string, Readonly<{ id: string; operations: Readonly<Record<string, "read" | "stream" | "mutation"> }>>>;
export function assertProviderConformance(providerKey: string, provider: object): object;
export function assertProviderSuiteConformance<T extends ThralloProviderSuite>(suite: T): T;
export function redact<T>(value: T): T;
export function redactText(value: unknown): string;
