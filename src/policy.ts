/** A Discord access policy. Every dimension is deny-by-default. `*` is explicit wildcard. */
export interface AccessPolicy {
  guildIds: readonly string[];
  channelIds: readonly string[];
  userIds: readonly string[];
  roleIds: readonly string[];
}

export interface AuthorizationContext {
  guildId: string | null;
  channelId: string | null;
  userId: string;
  roleIds: readonly string[];
}

export type AuthorizationDenial =
  | 'guild_not_allowed'
  | 'channel_not_allowed'
  | 'identity_not_allowed';

export interface AuthorizationDecision {
  allowed: boolean;
  reason?: AuthorizationDenial;
}

/** A usable policy names a guild, channel, and at least one identity rule. */
export function completeDiscordPolicy(policy: AccessPolicy): boolean {
  return Boolean(
    policy.guildIds.length &&
      policy.channelIds.length &&
      (policy.userIds.length || policy.roleIds.length),
  );
}

function includes(list: readonly string[], value: string | null): boolean {
  if (list.includes('*')) return value !== null;
  return value !== null && list.includes(value);
}

/**
 * Authorize a command without relying on command-registration scope. A guild
 * and channel must both be explicitly listed, and the caller must match either
 * the user or role allowlist. This makes an accidentally empty configuration
 * fail closed instead of exposing a shared knowledge base to a whole server.
 */
export function authorize(
  policy: AccessPolicy,
  context: AuthorizationContext,
): AuthorizationDecision {
  if (!includes(policy.guildIds, context.guildId)) {
    return { allowed: false, reason: 'guild_not_allowed' };
  }
  if (!includes(policy.channelIds, context.channelId)) {
    return { allowed: false, reason: 'channel_not_allowed' };
  }
  const userAllowed = includes(policy.userIds, context.userId);
  const roleAllowed = context.roleIds.some((roleId) => includes(policy.roleIds, roleId));
  if (!userAllowed && !roleAllowed) {
    return { allowed: false, reason: 'identity_not_allowed' };
  }
  return { allowed: true };
}

export function explainDenial(reason: AuthorizationDenial | undefined): string {
  switch (reason) {
    case 'guild_not_allowed':
      return 'This server is not on the Chronicle allowlist.';
    case 'channel_not_allowed':
      return 'Chronicle is not authorized in this channel.';
    case 'identity_not_allowed':
      return 'Your user or role is not authorized for this Chronicle action.';
    default:
      return 'Chronicle is not authorized for this action.';
  }
}
