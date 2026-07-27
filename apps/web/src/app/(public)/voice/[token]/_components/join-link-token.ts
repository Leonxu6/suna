const JOIN_LINK_TOKEN_PREFIX = 'vjl_';

/** Returns true for a short server-resolved voice join-link token. */
export function isJoinLinkToken(pathSegment: string): boolean {
  return pathSegment.startsWith(JOIN_LINK_TOKEN_PREFIX);
}
