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

export type NativeAuthState =
  | "signed_out" | "authorizing" | "awaiting_callback" | "exchanging" | "authenticated"
  | "refreshing" | "expired" | "revoked" | "offline" | "error";

export interface NativeAuthSnapshot {
  readonly state: NativeAuthState;
  readonly method: "native_browser_pkce" | "legacy_manual_pat" | null;
  readonly accountId: string | null;
  readonly deviceId: string;
  readonly expiresAt: number | null;
  readonly error: Readonly<{ code: string; message: string }> | null;
}

export interface PkceTransaction {
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
  readonly nonce: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface DeviceSession {
  readonly accountId: string;
  readonly deviceId: string;
  readonly accessHandle: string;
  readonly refreshHandle: string;
  readonly accessExpiresAt: number;
  readonly sessionRevision: number;
}

export interface CredentialScope {
  readonly accountId: string;
  readonly deviceId: string;
  readonly kind: string;
}

export interface CredentialVault {
  readonly kind: string;
  readonly persistent: boolean;
  store(scope: CredentialScope, value: unknown): Promise<Readonly<{ revision: number }>>;
  retrieve(scope: CredentialScope): Promise<Readonly<{ value: any; revision: number }> | null>;
  replace(scope: CredentialScope, value: unknown, options: { expectedRevision: number }): Promise<Readonly<{ revision: number }>>;
  delete(scope: CredentialScope): Promise<Readonly<{ deleted: boolean }>>;
}

export interface NativeAuthProvider {
  readonly kind: string;
  readonly capabilities: Readonly<{ browserAuthorization: boolean; productionMutation: boolean }>;
  beginAuthorization(input: Readonly<{
    challenge: string; state: string; nonce: string; redirectUri: "thrallo://auth/callback";
    deviceId: string; expectedAccountId?: string | null;
  }>): Promise<Readonly<{ authorizationId: string; authorizationUrl: string; expiresAt: number }>>;
  exchangeAuthorizationCode(input: Readonly<{
    authorizationId: string; code: string; verifier: string; state: string; nonce: string; deviceId: string;
  }>): Promise<DeviceSession>;
  refreshDeviceSession(input: Readonly<{
    accountId: string; deviceId: string; refreshHandle: string; sessionRevision: number;
  }>): Promise<DeviceSession>;
  revokeDeviceSession(input: Readonly<{ accountId: string; deviceId: string; refreshHandle: string }>): Promise<Readonly<{ revoked: boolean }>>;
  getConnectivity?(): "online" | "offline";
}

export interface NativeAuthControllerOptions {
  provider: NativeAuthProvider;
  vault: CredentialVault;
  capabilities: HostCapabilities;
  browser: { openExternal(url: string): Promise<void> | void };
  deviceId: string;
  now?: () => number;
  pkceFactory?: (options: { createdAt: number }) => Promise<PkceTransaction>;
}

export class NativeAuthController {
  constructor(options: NativeAuthControllerOptions);
  getSnapshot(): NativeAuthSnapshot;
  subscribe(listener: (snapshot: NativeAuthSnapshot) => void): () => void;
  startup(): Promise<NativeAuthSnapshot>;
  startAuthorization(options?: { expectedAccountId?: string | null }): Promise<Readonly<{ authorizationId: string; expiresAt: number }>>;
  handleCallback(url: string): Promise<NativeAuthSnapshot>;
  refresh(): Promise<NativeAuthSnapshot>;
  reconnect(): Promise<NativeAuthSnapshot>;
  logout(): Promise<NativeAuthSnapshot>;
  switchAccount(accountId: string): Promise<Readonly<{ authorizationId: string; expiresAt: number }>>;
}

export const NATIVE_AUTH_STATES: readonly NativeAuthState[];
export const NATIVE_AUTH_PROVIDER_METHODS: readonly string[];
export const AUTH_CONNECTION_METHODS: Readonly<{ preferred: "native_browser_pkce"; legacy: "legacy_manual_pat" }>;
export const AUTH_FIXTURE_CLOCK: string;
export const AUTH_FIXTURE_SEED: string;
export function canTransitionAuthState(from: string, to: string): boolean;
export function assertAuthTransition(from: string, to: string): string;
export function createPkceVerifier(options?: { randomBytes?: (length: number) => Uint8Array }): string;
export function createCorrelationValue(options?: { randomBytes?: (length: number) => Uint8Array }): string;
export function createPkceChallenge(verifier: string, options?: { digest?: (value: Uint8Array) => Promise<Uint8Array> | Uint8Array }): Promise<string>;
export function createPkceTransaction(options?: { randomBytes?: (length: number) => Uint8Array; createdAt?: number; expiresInMs?: number }): Promise<PkceTransaction>;
export function constantTimeEqual(left: unknown, right: unknown): boolean;
export function parseAuthCallback(value: string): Readonly<{ code: string | null; state: string; error: string | null; errorDescription: string | null }>;
export function correlateAuthCallback(callback: ReturnType<typeof parseAuthCallback>, expectedState: string, options?: { now?: number; expiresAt?: number }): ReturnType<typeof parseAuthCallback>;
export function findAuthCallbackArgument(argumentsList?: readonly string[]): string | null;
export function createNativeAuthDeepLinkDispatcher(options: { controller: NativeAuthController }): Readonly<{
  handleOpenUrl(url: string): Promise<NativeAuthSnapshot>;
  handleLaunchArguments(argumentsList: readonly string[]): Promise<NativeAuthSnapshot | null>;
}>;
export function createNativeCredentialVault(options: { secretStorage: { get(key: string): Promise<string | undefined>; store(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }; keyPrefix?: string }): CredentialVault;
export function createDevelopmentCredentialVault(options?: { failOperations?: readonly string[] }): CredentialVault & { getCalls(): readonly unknown[]; inspectKeys(): readonly string[]; setFailure(operation: string, enabled?: boolean): void };
export function assertNativeAuthProvider<T extends NativeAuthProvider>(provider: T): T;
export function createUnavailableServerAuthProvider(): NativeAuthProvider;
export function createLegacyPatConnection(options: { getPat(): Promise<string | null> | string | null }): Readonly<{ mode: "legacy_manual_pat"; preferred: false; getAuthHeaders(): Promise<Record<string, string>> }>;
export function createNativeAuthController(options: NativeAuthControllerOptions): NativeAuthController;
export function createDeterministicAuthProvider(options?: { seed?: string; clock?: string; authorizationLifetimeMs?: number; accessLifetimeMs?: number }): NativeAuthProvider & {
  completeAuthorization(authorizationId: string, overrides?: { code?: string; state?: string }): string;
  revokeDevice(input: { accountId: string; deviceId: string }): void;
  setOffline(value?: boolean): void;
  advance(milliseconds: number): number;
  now(): number;
  getCalls(): readonly unknown[];
};
