# auth.md — Arkova agent authentication

Authentication and credential-provisioning instructions for AI agents and
server-side integrations using Arkova's API and MCP server.

## Scoped Arkova API keys

An Arkova organization administrator provisions and revokes scoped API keys at:

<https://app.arkova.ai/settings/api-keys>

Send a key in one of these headers:

```http
X-API-Key: YOUR_ARKOVA_API_KEY
```

```http
Authorization: Bearer YOUR_ARKOVA_API_KEY
```

The raw key is displayed once. Store it in a secrets manager, never in source
control, prompts, browser code, or logs. Grant only the scopes the agent needs.

## Interactive OpenID Connect

Arkova's production user identity issuer is:

<https://vzwyaatejekddvltxyye.supabase.co/auth/v1>

Its canonical discovery document is:

<https://vzwyaatejekddvltxyye.supabase.co/auth/v1/.well-known/openid-configuration>

Dynamic client registration is not currently available. This flow is for
approved, user-delegated integrations. Contact <hello@arkova.ai> for reviewed
enterprise OIDC onboarding.

## Protected resources

- API: <https://api.arkova.ai/v2>
- OpenAPI document: <https://api.arkova.ai/v2/openapi.json>
- MCP server: <https://edge.arkova.ai/mcp>
- OAuth Protected Resource Metadata:
  <https://app.arkova.ai/.well-known/oauth-protected-resource>

Public verification reads may be anonymous. Protected API and MCP operations
require a scoped API key or an approved user-delegated bearer token.

## Registration and revocation

Arkova does not expose unattended public agent registration.

1. An organization administrator signs in to Arkova.
2. The administrator opens <https://app.arkova.ai/settings/api-keys>.
3. The administrator creates a named, least-privilege key for the agent.
4. The operator stores the one-time key securely and sends it by header.
5. The administrator rotates or revokes the key from the same settings page.
