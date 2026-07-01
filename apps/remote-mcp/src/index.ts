import { Hono } from "hono";
import { createClerkClient } from "@clerk/backend";
import {
  corsHeaders,
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
  verifyClerkToken,
} from "@clerk/mcp-tools/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { sendTelegramMessage, telegramMessageInputSchema } from "sendkit-core";

const secretKey = process.env.CLERK_SECRET_KEY;
const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;

if (!secretKey || !publishableKey) {
  throw new Error("Missing CLERK_SECRET_KEY or CLERK_PUBLISHABLE_KEY environment variables.");
}

const clerkClient = createClerkClient({ secretKey, publishableKey });

function createServer(botToken: string) {
  const server = new McpServer({
    name: "sendkit-remote",
    version: "0.0.0",
  });

  server.registerTool(
    "telegram",
    {
      title: "Telegram",
      description: "Send a Telegram message.",
      inputSchema: telegramMessageInputSchema.shape,
    },
    async (input) => {
      const result = await sendTelegramMessage({
        ...input,
        botToken,
      });

      return {
        content: [
          {
            type: "text",
            text: `Sent Telegram message ${result.messageId} to chat ${result.chatId}`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  return server;
}

const app = new Hono();

// Public OAuth discovery endpoints so MCP clients can find where to authenticate.
app.get("/.well-known/oauth-protected-resource", (c) => {
  const metadata = generateClerkProtectedResourceMetadata({
    publishableKey,
    // resourceUrl: new URL(`/${c.req.param("botToken")}/mcp`, c.req.url).toString(),
    resourceUrl: new URL(c.req.url).origin,
  });
  return c.json(metadata, 200, corsHeaders);
});

app.get("/.well-known/oauth-authorization-server", async (c) => {
  const metadata = await fetchClerkAuthorizationServerMetadata({ publishableKey });
  return c.json(metadata, 200, corsHeaders);
});

app.post("/:botToken/mcp", async (c) => {
  const requestState = await clerkClient.authenticateRequest(c.req.raw, {
    acceptsToken: "oauth_token",
  });
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
  const authInfo = verifyClerkToken(requestState.toAuth(), token);

  if (!authInfo) {
    const resourceMetadataUrl = `${new URL(c.req.url).origin}/.well-known/oauth-protected-resource`;
    return c.json({ error: "Unauthorized" }, 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
    });
  }

  const botToken = c.req.param("botToken");
  const server = createServer(botToken);

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

app.notFound((c) => c.json({ error: "Not Found" }, 404));

const port = Number(process.env.PORT || 3000);

export default {
  port,
  fetch: (req: Request) => {
    const url = new URL(req.url);
    url.protocol = req.headers.get("x-forwarded-proto") || url.protocol;
    url.host = req.headers.get("x-forwarded-host") || url.host;

    return app.fetch(new Request(url.toString(), req));
  },
};
