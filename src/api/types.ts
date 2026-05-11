import type { Hono } from 'hono';
import type { AgentSdk } from '@treeseed/sdk';
import type {
	ApiPrincipal,
	ApiScope,
	DeviceCodeApproveRequest as SdkDeviceCodeApproveRequest,
	DeviceCodePollRequest,
	DeviceCodePollResponse,
	DeviceCodeStartRequest,
	DeviceCodeStartResponse,
	RemoteWorkflowOperationRequest as WorkflowHttpOperationRequest,
	RemoteWorkflowOperationResponse as ApiWorkflowOperationResponse,
	RemoteSdkOperationRequest as SdkHttpOperationRequest,
	TokenRefreshRequest,
	TokenRefreshResponse,
} from '@treeseed/sdk/remote';

export type {
	ApiPrincipal,
	ApiScope,
	DeviceCodePollRequest,
	DeviceCodePollResponse,
	DeviceCodeStartRequest,
	DeviceCodeStartResponse,
	WorkflowHttpOperationRequest,
	ApiWorkflowOperationResponse,
	SdkHttpOperationRequest,
	TokenRefreshRequest,
	TokenRefreshResponse,
};

export type DeviceCodeApproveRequest = SdkDeviceCodeApproveRequest;

export interface ApiAuthProvider {
	readonly id: string;
	startDeviceFlow(request: DeviceCodeStartRequest): Promise<DeviceCodeStartResponse>;
	pollDeviceFlow(request: DeviceCodePollRequest): Promise<DeviceCodePollResponse>;
	refreshAccessToken(request: TokenRefreshRequest): Promise<TokenRefreshResponse>;
	approveDeviceFlow(request: DeviceCodeApproveRequest): Promise<{ ok: true }>;
	authenticateBearerToken(token: string): Promise<{ principal: ApiPrincipal; credential: ApiCredential } | null>;
	authenticateServiceCredential(serviceId: string, secret: string): Promise<{ principal: ApiPrincipal; credential: ApiCredential } | null>;
	createPersonalAccessToken(
		userId: string,
		input: { name: string; scopes?: string[]; expiresAt?: string | null },
	): Promise<{ id: string; token: string; prefix: string; name: string; expiresAt: string | null }>;
	listPersonalAccessTokens(userId: string): Promise<Array<{
		id: string;
		name: string;
		token_prefix: string;
		expires_at: string | null;
		last_used_at: string | null;
		revoked_at: string | null;
		created_at: string;
	}>>;
	revokePersonalAccessToken(userId: string, tokenId: string): Promise<void>;
	syncUserIdentity(identity: UserIdentityProfileInput): Promise<{
		principal: ApiPrincipal;
		userId: string;
		identityId: string | null;
	}>;
	createUser?(input: { email?: string | null; username?: string | null; displayName?: string | null; metadata?: Record<string, unknown> }): Promise<{
		principal: ApiPrincipal;
		userId: string;
	}>;
	setUserRoles?(userId: string, roles: string[]): Promise<{
		principal: ApiPrincipal;
		userId: string;
	}>;
	createServiceToken(input: { serviceId: string; name: string; roles?: string[]; permissions?: string[] }): Promise<{
		id: string;
		serviceId: string;
		secret: string;
	}>;
	rotateServiceToken(serviceId: string): Promise<{
		id: string;
		serviceId: string;
		secret: string;
	}>;
	createTrustedUserAssertion(claims: TrustedUserAssertionClaims): string;
	verifyTrustedUserAssertion(assertion: string): TrustedUserAssertionClaims | null;
	exchangeTrustedUserAssertion(claims: TrustedUserAssertionClaims): Promise<{
		ok: true;
		accessToken: string;
		tokenType: 'Bearer';
		expiresAt: string;
		expiresInSeconds: number;
		principal: ApiPrincipal;
	}>;
}

export type ApiRuntimeProviderSelections = {
	auth: string;
	agents: {
		execution: string;
		queue: string;
		notification: string;
		repository: string;
		verification: string;
	};
};

export interface ApiConfig {
	name: string;
	host: string;
	port: number;
	baseUrl: string;
	issuer: string;
	repoRoot: string;
	projectId: string;
	authSecret: string;
	projectApiKey?: string;
	projectApiLabel: string;
	projectApiPermissions: string[];
	cloudflareAccountId?: string;
	cloudflareApiToken?: string;
	d1DatabaseId?: string;
	d1DatabaseName?: string;
	d1LocalPersistTo?: string;
	d1WranglerConfigPath?: string;
	webServiceId: string;
	webServiceSecret: string;
	webAssertionSecret: string;
	webExchangeTtlSeconds: number;
	bootstrapAdminAllowlist: string[];
	accessTokenTtlSeconds: number;
	refreshTokenTtlSeconds: number;
	deviceCodeTtlSeconds: number;
	deviceCodePollIntervalSeconds: number;
	templateCatalogPath?: string;
	providers: ApiRuntimeProviderSelections;
}

export interface AppVariables {
	requestId: string;
	config: ApiConfig;
	principal: ApiPrincipal | null;
	actingUser: ApiPrincipal | null;
	credential: ApiCredential | null;
	actorType: 'anonymous' | 'user' | 'service' | 'project';
	permissionGrants: string[];
}

export interface ApiCredential {
	type: 'access_token' | 'personal_access_token' | 'service_secret' | 'service_token' | 'project_api_key' | 'team_api_key';
	id: string;
	label?: string;
}

export interface TrustedUserAssertionClaims {
	userId: string;
	sessionId: string;
	identityId?: string | null;
	teamId?: string | null;
	projectId?: string | null;
	membershipId?: string | null;
	teamRoles?: string[];
	teamCapabilities?: string[];
	authTime: string;
	expiresAt: string;
	nonce: string;
}

export interface UserIdentityProfileInput {
	provider: string;
	providerSubject: string;
	email?: string | null;
	emailVerified?: boolean;
	username?: string | null;
	displayName?: string | null;
	profile?: Record<string, unknown>;
}

export type ApiProviderFactory<T> = (options: { config: ApiConfig }) => T;

export interface ApiRuntimeProviders {
	auth?: Record<string, ApiProviderFactory<ApiAuthProvider>>;
	agentExecution?: Record<string, unknown>;
	agentQueue?: Record<string, unknown>;
	agentNotification?: Record<string, unknown>;
	agentRepository?: Record<string, unknown>;
	agentVerification?: Record<string, unknown>;
}

export interface ResolvedApiRuntimeProviders {
	auth: ApiAuthProvider;
	registries: {
		auth: Map<string, ApiProviderFactory<ApiAuthProvider>>;
		agentExecution: Map<string, unknown>;
		agentQueue: Map<string, unknown>;
		agentNotification: Map<string, unknown>;
		agentRepository: Map<string, unknown>;
		agentVerification: Map<string, unknown>;
	};
	selections: ApiRuntimeProviderSelections;
}

export interface ApiResolvedSettings {
	config: ApiConfig;
	surfaces: {
		auth: boolean;
		templates: boolean;
		sdk: boolean;
		agent: boolean;
		operations: boolean;
		project: boolean;
	};
	scopes: {
		authMe: ApiScope;
		sdk: ApiScope;
		agent: ApiScope;
		operations: ApiScope;
	};
}

export interface ApiAppRuntime {
	resolved: ApiResolvedSettings;
	runtimeProviders: ResolvedApiRuntimeProviders;
	sharedSdk: AgentSdk;
	internalPrefix: string;
}

export type TreeseedApiContext = ApiAppRuntime;

export interface TreeseedApiExtension {
	name: string;
	mount(app: Hono<any>, context: TreeseedApiContext): void | Promise<void>;
}

export interface ApiServerOptions {
	config?: Partial<ApiConfig>;
	runtimeProviders?: ApiRuntimeProviders;
	sdk?: AgentSdk;
	workflowExecutor?: (operation: string, request: WorkflowHttpOperationRequest) => Promise<ApiWorkflowOperationResponse>;
	surfaces?: Partial<{
		auth: boolean;
		templates: boolean;
		sdk: boolean;
		agent: boolean;
		operations: boolean;
		project: boolean;
	}>;
	scopes?: Partial<{
		authMe: ApiScope;
		sdk: ApiScope;
		agent: ApiScope;
		operations: ApiScope;
	}>;
	internalPrefix?: string;
	extensions?: TreeseedApiExtension[];
	extendApp?: (app: Hono<any>, runtime: ApiAppRuntime) => void;
	log?: (message: string, details?: Record<string, unknown>) => void;
}
