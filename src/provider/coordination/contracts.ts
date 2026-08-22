export interface ProviderControlPlaneConnection {
	controlPlaneUrl: string;
	accessToken: string;
	accessTokenProvider?: () => Promise<string>;
}
