import { randomUUID } from 'node:crypto';
import type { UserIdentityProfileInput } from '../types.ts';
import { D1AuthStoreCore, isoNow } from './d1-store-core.ts';

export abstract class D1AuthUserStore extends D1AuthStoreCore {
	async syncUser(identity: UserIdentityProfileInput) {
		await this.ensureInitialized();
		const nowIso = isoNow();
		const existingIdentity = await this.loadIdentityByProvider(identity.provider, identity.providerSubject);
		let userId = existingIdentity?.user_id;
		if (!userId) {
			const emailLinkedUser = identity.email && identity.emailVerified ? await this.loadUserByVerifiedEmail(identity.email) : null;
			const usernameLinkedUser = !emailLinkedUser && identity.username ? await this.loadUserByUsername(identity.username) : null;
			const linkedUser = emailLinkedUser ?? (this.canAdoptUsernameMatch(identity, usernameLinkedUser) ? usernameLinkedUser : null);
			userId = linkedUser?.id ?? randomUUID();
			if (linkedUser) {
				await this.run(
					`UPDATE users
					 SET email = COALESCE(?, email),
					     username = COALESCE(username, ?),
					     display_name = COALESCE(?, display_name),
					     metadata_json = ?,
					     updated_at = ?
					 WHERE id = ?`,
					[
						identity.email ?? null,
						identity.username ?? null,
						identity.displayName ?? null,
						JSON.stringify(this.userMetadata(identity, linkedUser.username ?? null)),
						nowIso,
						userId,
					],
				);
			} else {
				await this.run(
					`INSERT INTO users (id, email, username, display_name, status, metadata_json, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
					[
						userId,
						identity.email ?? null,
						identity.username ?? null,
						identity.displayName ?? null,
						JSON.stringify(this.userMetadata(identity)),
						nowIso,
						nowIso,
					],
				);
			}
			await this.run(
				`INSERT INTO user_identities (id, user_id, provider, provider_subject, email, email_verified, profile_json, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					userId,
					identity.provider,
					identity.providerSubject,
					identity.email ?? null,
					identity.emailVerified ? 1 : 0,
					JSON.stringify(identity.profile ?? {}),
					nowIso,
					nowIso,
				],
			);
		} else {
			await this.run(
				`UPDATE users
				 SET email = COALESCE(?, email),
				     username = COALESCE(username, ?),
				     display_name = COALESCE(?, display_name),
				     metadata_json = ?,
				     updated_at = ?
				 WHERE id = ?`,
				[
					identity.email ?? null,
					identity.username ?? null,
					identity.displayName ?? null,
					JSON.stringify(this.userMetadata(identity)),
					nowIso,
					userId,
				],
			);
			await this.run(
				`UPDATE user_identities
				 SET email = ?, email_verified = ?, profile_json = ?, updated_at = ?
				 WHERE provider = ? AND provider_subject = ?`,
				[
					identity.email ?? null,
					identity.emailVerified ? 1 : 0,
					JSON.stringify(identity.profile ?? {}),
					nowIso,
					identity.provider,
					identity.providerSubject,
				],
			);
		}
		await this.bootstrapRolesForUser(userId, identity);
		await this.writeAuditEvent({
			actorType: 'service',
			actorId: this.config.webServiceId,
			eventType: 'auth.user_synced',
			targetType: 'user',
			targetId: userId,
			data: { provider: identity.provider },
		});
		const principal = await this.principalForUser(userId);
		const syncedIdentity = await this.loadIdentityByProvider(identity.provider, identity.providerSubject);
		return {
			...principal,
			identityId: syncedIdentity?.id ?? null,
		};
	}

	async createUser(input: { email?: string | null; username?: string | null; displayName?: string | null; metadata?: Record<string, unknown> }) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const userId = randomUUID();
		await this.run(
			`INSERT INTO users (id, email, username, display_name, status, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
			[
				userId,
				input.email?.trim() || null,
				input.username?.trim().toLowerCase() || null,
				input.displayName?.trim() || null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.assignRole(userId, 'member');
		await this.writeAuditEvent({
			actorType: 'service',
			actorId: this.config.webServiceId,
			eventType: 'auth.user_created',
			targetType: 'user',
			targetId: userId,
			data: { source: 'admin' },
		});
		return this.principalForUser(userId);
	}

	async setUserRoles(userId: string, roles: string[]) {
		await this.ensureInitialized();
		const requestedRoles = [...new Set(roles.map((role) => role.trim()).filter(Boolean))];
		await this.replaceRoles(userId, requestedRoles.length > 0 ? requestedRoles : ['member']);
		await this.writeAuditEvent({
			actorType: 'service',
			actorId: this.config.webServiceId,
			eventType: 'auth.user_roles_set',
			targetType: 'user',
			targetId: userId,
			data: { roles: requestedRoles },
		});
		return this.principalForUser(userId);
	}
}

