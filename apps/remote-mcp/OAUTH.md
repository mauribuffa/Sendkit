# OAuth for the Remote MCP Server — Handoff

This document explains how authentication works on the remote MCP server
(`apps/remote-mcp/src/index.ts`): first OAuth in general, then the `.well-known`
discovery mechanism, then exactly how Clerk wires into this codebase.

---

## 1. OAuth in general (the 2-minute model)

OAuth 2.1 solves one problem: **let a client call a protected API on behalf of a
user, without the client ever seeing the user's password.**

There are four roles:

| Role                          | Who it is here                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| **Resource Owner**            | The human user.                                                                      |
| **Client**                    | The app making requests — e.g. an MCP client like Claude, Cursor, the MCP Inspector. |
| **Authorization Server (AS)** | Issues tokens after the user logs in. **This is Clerk.**                             |
| **Resource Server (RS)**      | The API that holds protected data and checks tokens. **This is our MCP server.**     |

The flow, end to end:

```
1. Client wants to call the Resource Server.
2. Resource Server says "401 — you need a token, here's WHERE to get one."
3. Client redirects the user to the Authorization Server (Clerk) to log in.
4. User logs in & consents. Clerk redirects back with an authorization code.
5. Client exchanges that code (+ PKCE proof) for an ACCESS TOKEN.
6. Client retries the API call with `Authorization: Bearer <access_token>`.
7. Resource Server verifies the token and serves the request.
```

Key properties:

- The **access token** is a short-lived credential (here, a Clerk-issued
  `oauth_token`). The client sends it on every request.
- **PKCE** (Proof Key for Code Exchange) stops an intercepted authorization code
  from being usable by an attacker. It's mandatory in OAuth 2.1.
- The Resource Server never stores passwords and never talks to the user's
  credentials — it only **verifies tokens** the AS minted.

### Why this matters for MCP

MCP clients are arbitrary third-party apps. They can't be pre-registered by hand,
and they must discover _on their own_ how to authenticate to whatever server a
user points them at. OAuth 2.1 + the discovery metadata below makes that
automatic: a client can walk up to any compliant MCP server and figure out the
whole login flow from a single 401 response.

---

## 2. The `.well-known` thing (discovery)

`.well-known/` is a **standardized URL prefix** (RFC 8615). The idea: if every
server publishes machine-readable config at a _predictable, fixed path_, clients
can discover capabilities without anyone hand-configuring them. You've seen this
pattern before — `/.well-known/security.txt`, `/.well-known/apple-app-site-association`,
ACME/Let's Encrypt challenges, etc.

OAuth uses it for two discovery documents:

### a) Protected Resource Metadata — `/.well-known/oauth-protected-resource` (RFC 9728)

Served by the **Resource Server** (us). It answers the client's question:
_"I got a 401 from this API — which authorization server do I log in to?"_

Our server returns (see the live output):

```json
{
  "resource": "http://localhost:3999",
  "authorization_servers": ["https://<your>.clerk.accounts.dev"],
  "token_types_supported": ["urn:ietf:params:oauth:token-type:access_token"],
  "jwks_uri": "https://<your>.clerk.accounts.dev/.well-known/jwks.json",
  ...
}
```

The critical field is `authorization_servers` — it points the client at Clerk.

### b) Authorization Server Metadata — `/.well-known/oauth-authorization-server` (RFC 8414)

Describes the **Authorization Server** (Clerk): where to send the user to log in
(`authorization_endpoint`), where to exchange the code for a token
(`token_endpoint`), where clients can self-register
(`registration_endpoint`), supported scopes, etc.

Clerk is the real source of truth for this, so our handler just proxies Clerk's
copy via `fetchClerkAuthorizationServerMetadata`.

### How a client chains them together

```
POST /:botToken/mcp                  → 401 + WWW-Authenticate: Bearer
                                         resource_metadata="…/.well-known/oauth-protected-resource"
GET  /.well-known/oauth-protected-resource   → { authorization_servers: [Clerk] }
GET  Clerk/.well-known/oauth-authorization-server → { authorization_endpoint, token_endpoint, registration_endpoint }
→ (optional) register client at registration_endpoint  (Dynamic Client Registration)
→ redirect user to authorization_endpoint, log in, get code
→ exchange code at token_endpoint → access token
POST /:botToken/mcp  + Authorization: Bearer <token>  → 200 ✅
```

The `WWW-Authenticate` response header is the entry point of this whole chain —
it's how a 401 tells the client _where_ the discovery document lives.

### Dynamic Client Registration (DCR)

Normally an app developer manually registers their app with an AS to get a
`client_id`. MCP clients are too numerous and too dynamic for that, so they use
**DCR**: the client POSTs to the AS's `registration_endpoint` and gets a
`client_id` on the fly. This is why the setup requires enabling **Dynamic client
registration** in the Clerk Dashboard — without it, MCP clients can't bootstrap.

---

## 3. How Clerk wires into this server

We use two Clerk packages, both framework-agnostic (they operate on the Web
Standard `Request`/`Response`, which is what Hono/Bun use — no Express needed):

- **`@clerk/backend`** → `createClerkClient(...)` and `authenticateRequest(...)`,
  which inspects an incoming `Request` and tells us if it carries a valid token.
- **`@clerk/mcp-tools/server`** → MCP-specific glue:
  - `generateClerkProtectedResourceMetadata(...)` — builds the RFC 9728 doc.
  - `fetchClerkAuthorizationServerMetadata(...)` — proxies the RFC 8414 doc.
  - `verifyClerkToken(authObject, token)` — converts Clerk's auth result into the
    `AuthInfo` shape the MCP SDK expects (or `undefined` if invalid).
  - `corsHeaders` — permissive CORS so public clients can read the metadata.

### The request path, mapped to the code

**Startup** — fail fast if keys are missing, then make one Clerk client:

```ts
const clerkClient = createClerkClient({ secretKey, publishableKey });
```

**Discovery endpoints** — public, no auth, so clients can read them:

```ts
app.get("/.well-known/oauth-protected-resource", (c) => {
  const metadata = generateClerkProtectedResourceMetadata({
    publishableKey,
    resourceUrl: new URL(c.req.url).origin,
  });
  return c.json(metadata, 200, corsHeaders);
});

app.get("/.well-known/oauth-authorization-server", async (c) => {
  const metadata = await fetchClerkAuthorizationServerMetadata({ publishableKey });
  return c.json(metadata, 200, corsHeaders);
});
```

**Protected MCP endpoint** — verify, then serve:

```ts
app.post("/:botToken/mcp", async (c) => {
  // 1. Ask Clerk to inspect the request, only accepting OAuth tokens.
  const requestState = await clerkClient.authenticateRequest(c.req.raw, {
    acceptsToken: "oauth_token",
  });

  // 2. Pull the raw bearer token out of the Authorization header.
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;

  // 3. Turn Clerk's result into MCP AuthInfo (undefined => not authenticated).
  const authInfo = verifyClerkToken(requestState.toAuth(), token);

  // 4. No valid token => 401 that points the client at discovery.
  if (!authInfo) {
    const resourceMetadataUrl = `${new URL(c.req.url).origin}/.well-known/oauth-protected-resource`;
    return c.json({ error: "Unauthorized" }, 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
    });
  }

  // 5. Authenticated: run the MCP request, passing authInfo down to tools.
  const server = createServer(c.req.param("botToken"));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw, { authInfo });
  } finally {
    await server.close();
  }
});
```

### Two orthogonal concepts: identity vs. tenant

This server has **two** independent pieces of information per request, and it's
important not to confuse them:

- **`Authorization: Bearer <oauth_token>`** — _who_ is calling. Verified by Clerk.
  This is authentication.
- **`:botToken` path param** — _which_ Telegram bot to send through. This is a
  tenant/routing selector, passed into `createServer(botToken)` and ultimately to
  `sendTelegramMessage`.

A valid Clerk token does **not** grant access to any particular bot; it just
proves the caller is a legitimate, logged-in user. The bot token in the URL is
what scopes the action to a specific Telegram bot.

> Security note: because the bot token currently lives in the URL path, anyone
> with a valid Clerk token _and_ knowledge of a bot token can use that bot. If
> bot tokens should be tied to specific users, that mapping would need to live in
> a datastore keyed by the authenticated `userId` (available from `authInfo`),
> rather than being trusted from the URL. Out of scope for the current change,
> but worth flagging for whoever picks this up.

---

## 4. Configuration checklist

**Clerk Dashboard:**

1. Create an **OAuth application**.
2. Enable **Dynamic client registration** (required for MCP clients to self-register).

**`apps/remote-mcp/.env`:**

```
CLERK_SECRET_KEY=sk_...
CLERK_PUBLISHABLE_KEY=pk_...
```

**Run:**

```
bun run dev:remote-mcp        # Bun auto-loads .env
```

---

## 5. References

- OAuth 2.1 draft — the consolidated spec MCP targets.
- RFC 8615 — `.well-known` URI registry.
- RFC 9728 — OAuth 2.0 Protected Resource Metadata.
- RFC 8414 — OAuth 2.0 Authorization Server Metadata.
- RFC 7591 — OAuth 2.0 Dynamic Client Registration.
- Clerk MCP docs — https://clerk.com/docs/guides/development/mcp/overview
- MCP authorization spec — https://modelcontextprotocol.io (Authorization section).
