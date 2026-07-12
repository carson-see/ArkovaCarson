const ADMIN_ROUTER_PREFIXES = [
  '/admin',
  '/anchor',
  '/compliance-inbox',
  '/connectors',
  '/notifications',
  '/proof-packet',
  '/queue',
  '/rules',
  '/treasury',
] as const;

export function isAdminRouterPath(path: string): boolean {
  return ADMIN_ROUTER_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
