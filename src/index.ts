/**
 * Macrodata - Cloud Memory MCP Server
 *
 * A remote MCP server that provides persistent memory for coding agents.
 * Built on Cloudflare Workers with Vectorize for semantic search.
 *
 * OAuth authentication via @cloudflare/workers-oauth-provider.
 * Google/GitHub act as upstream identity providers.
 */

import { Hono } from "hono";
import { html, raw } from "hono/html";
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Google, GitHub, generateState, generateCodeVerifier } from "arctic";
import { getAgentByName, routeAgentRequest } from "agents";
import { MemoryAgent } from "./mcp-agent";

// Re-export classes for wrangler
export { MemoryAgent };

// ==========================================
// Types
// ==========================================

interface PendingIdentityAuth {
	provider: "google" | "github";
	state: string;
	codeVerifier: string | null;
	mcpOAuthRequest: unknown;
	createdAt: number;
}

interface PendingMcpAuth {
	mcpName: string;
	mcpEndpoint: string;
	state: string;
	codeVerifier: string;
	userId: string;
	createdAt: number;
}

interface ConnectedMcp {
	name: string;
	endpoint: string;
	accessToken: string;
	refreshToken?: string;
	tokenExpiresAt?: number;
	connectedAt: string;
}

// Augment Cloudflare.Env with OAUTH_PROVIDER
import "./types";

// Hono context with OAuth props
type OAuthProps = {
	userId: string;
	email: string;
	provider: string;
	login?: string;
};

type Variables = {
	props?: OAuthProps;
};

// ==========================================
// Helpers
// ==========================================

function createIdentityProviders(env: Env) {
	const providers: { google?: Google; github?: GitHub } = {};
	const baseUrl = env.OAUTH_REDIRECT_BASE;

	if (!baseUrl) {
		console.warn("[OAUTH] OAUTH_REDIRECT_BASE not set");
		return providers;
	}

	if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
		providers.google = new Google(
			env.GOOGLE_CLIENT_ID,
			env.GOOGLE_CLIENT_SECRET,
			`${baseUrl}/callback/google`,
		);
	}

	if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
		providers.github = new GitHub(
			env.GITHUB_CLIENT_ID,
			env.GITHUB_CLIENT_SECRET,
			`${baseUrl}/callback/github`,
		);
	}

	return providers;
}

function isAllowedUser(email: string, env: Env): boolean {
	const allowedUsers = env.ALLOWED_USERS;
	if (!allowedUsers) return false;
	const allowed = allowedUsers.split(",").map((e) => e.trim().toLowerCase());
	return allowed.includes(email.toLowerCase());
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

// ==========================================
// HTML Layout
// ==========================================

const settingsLayout = (title: string, content: string) => html`
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${title} - Macrodata</title>
      <style>
        * {
          box-sizing: border-box;
        }
        body {
          font-family:
            system-ui,
            -apple-system,
            sans-serif;
          max-width: 600px;
          margin: 0 auto;
          padding: 2rem;
          background: #f5f5f5;
        }
        h1 {
          color: #333;
        }
        .card {
          background: white;
          border-radius: 8px;
          padding: 1.5rem;
          margin-bottom: 1rem;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }
        .mcp-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.75rem 0;
          border-bottom: 1px solid #eee;
        }
        .mcp-item:last-child {
          border-bottom: none;
        }
        .mcp-name {
          font-weight: 600;
        }
        .mcp-endpoint {
          color: #666;
          font-size: 0.875rem;
        }
        .btn {
          padding: 0.5rem 1rem;
          border-radius: 4px;
          border: none;
          cursor: pointer;
          font-size: 0.875rem;
        }
        .btn-primary {
          background: #2563eb;
          color: white;
        }
        .btn-danger {
          background: #dc2626;
          color: white;
        }
        .btn:hover {
          opacity: 0.9;
        }
        input[type="text"],
        input[type="url"] {
          width: 100%;
          padding: 0.5rem;
          border: 1px solid #ddd;
          border-radius: 4px;
          margin-bottom: 0.75rem;
        }
        label {
          display: block;
          margin-bottom: 0.25rem;
          font-weight: 500;
        }
        .form-group {
          margin-bottom: 1rem;
        }
        .status {
          padding: 0.5rem;
          border-radius: 4px;
          margin-bottom: 1rem;
        }
        .status-success {
          background: #d1fae5;
          color: #065f46;
        }
        .status-error {
          background: #fee2e2;
          color: #991b1b;
        }
        .empty {
          color: #666;
          font-style: italic;
        }
      </style>
    </head>
    <body>
      <h1>${title}</h1>
      ${raw(content)}
    </body>
  </html>
`;

// ==========================================
// Default App (unauthenticated routes)
// ==========================================

const defaultApp = new Hono<{ Bindings: Env }>();

// Health check
defaultApp.get("/health", (c) => {
	return c.json({
		name: "macrodata",
		status: "ok",
		version: "0.3.0",
		oauth: "cloudflare-provider",
	});
});

// MCP OAuth authorization endpoint
defaultApp.get("/authorize", async (c) => {
	try {
		const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
		const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);

		if (!clientInfo) {
			return c.text("Unknown client", 400);
		}

		const providers = createIdentityProviders(c.env);

		if (providers.google) {
			const state = generateState();
			const codeVerifier = generateCodeVerifier();
			const scopes = ["openid", "email", "profile"];

			const authUrl = providers.google.createAuthorizationURL(state, codeVerifier, scopes);
			authUrl.searchParams.set("access_type", "offline");
			authUrl.searchParams.set("prompt", "consent");

			const pending: PendingIdentityAuth = {
				provider: "google",
				state,
				codeVerifier,
				mcpOAuthRequest: oauthReqInfo,
				createdAt: Date.now(),
			};
			await c.env.OAUTH_KV.put(`pending:${state}`, JSON.stringify(pending), {
				expirationTtl: 600,
			});

			return c.redirect(authUrl.toString());
		} else if (providers.github) {
			const state = generateState();
			const scopes = ["user:email"];

			const authUrl = providers.github.createAuthorizationURL(state, scopes);

			const pending: PendingIdentityAuth = {
				provider: "github",
				state,
				codeVerifier: null,
				mcpOAuthRequest: oauthReqInfo,
				createdAt: Date.now(),
			};
			await c.env.OAUTH_KV.put(`pending:${state}`, JSON.stringify(pending), {
				expirationTtl: 600,
			});

			return c.redirect(authUrl.toString());
		}

		return c.text(
			"No identity provider configured. Set GOOGLE_CLIENT_ID/SECRET or GITHUB_CLIENT_ID/SECRET.",
			500,
		);
	} catch (error) {
		console.error("[AUTHORIZE] Error:", error);
		return c.text(
			`Authorization error: ${error instanceof Error ? error.message : String(error)}`,
			400,
		);
	}
});

// Google OAuth callback
defaultApp.get("/callback/google", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");
	const error = c.req.query("error");

	if (error) return c.text(`OAuth error: ${error}`, 400);
	if (!code || !state) return c.text("Missing code or state", 400);

	const pendingJson = await c.env.OAUTH_KV.get(`pending:${state}`);
	if (!pendingJson) return c.text("Invalid or expired OAuth state", 400);

	const pending = JSON.parse(pendingJson) as PendingIdentityAuth;
	if (pending.provider !== "google" || !pending.codeVerifier) {
		return c.text("Invalid OAuth state", 400);
	}

	const providers = createIdentityProviders(c.env);
	if (!providers.google) {
		return c.text("Google OAuth not configured", 500);
	}

	try {
		const tokens = await providers.google.validateAuthorizationCode(code, pending.codeVerifier);

		const userResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
			headers: { Authorization: `Bearer ${tokens.accessToken()}` },
		});

		if (!userResponse.ok) {
			throw new Error(`Failed to get user info: ${userResponse.status}`);
		}

		const userInfo = (await userResponse.json()) as {
			email: string;
			name?: string;
		};

		if (!isAllowedUser(userInfo.email, c.env)) {
			console.warn(`[CALLBACK/GOOGLE] Rejected user: ${userInfo.email}`);
			return c.text("Access denied. Your account is not authorized to use this service.", 403);
		}

		const mcpRequest = pending.mcpOAuthRequest as Awaited<
			ReturnType<OAuthHelpers["parseAuthRequest"]>
		>;
		const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
			request: mcpRequest,
			userId: userInfo.email,
			metadata: {
				provider: "google",
				email: userInfo.email,
				name: userInfo.name,
				authenticatedAt: new Date().toISOString(),
			},
			scope: mcpRequest.scope ?? [],
			props: {
				userId: userInfo.email,
				provider: "google",
				email: userInfo.email,
			},
		});

		await c.env.OAUTH_KV.delete(`pending:${state}`);
		return c.redirect(redirectTo);
	} catch (error) {
		console.error("[CALLBACK/GOOGLE] Error:", error);
		return c.text(
			`OAuth callback error: ${error instanceof Error ? error.message : String(error)}`,
			400,
		);
	}
});

// GitHub OAuth callback
defaultApp.get("/callback/github", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");
	const error = c.req.query("error");

	if (error) return c.text(`OAuth error: ${error}`, 400);
	if (!code || !state) return c.text("Missing code or state", 400);

	const pendingJson = await c.env.OAUTH_KV.get(`pending:${state}`);
	if (!pendingJson) return c.text("Invalid or expired OAuth state", 400);

	const pending = JSON.parse(pendingJson) as PendingIdentityAuth;
	if (pending.provider !== "github") return c.text("Invalid OAuth state", 400);

	const providers = createIdentityProviders(c.env);
	if (!providers.github) return c.text("GitHub OAuth not configured", 500);

	try {
		const tokens = await providers.github.validateAuthorizationCode(code);

		const userResponse = await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${tokens.accessToken()}`,
				Accept: "application/vnd.github.v3+json",
				"User-Agent": "macrodata-mcp",
			},
		});

		if (!userResponse.ok) {
			throw new Error(`Failed to get user info: ${userResponse.status}`);
		}

		const user = (await userResponse.json()) as {
			email: string | null;
			login: string;
			name?: string;
		};

		let email = user.email;
		if (!email) {
			const emailsResponse = await fetch("https://api.github.com/user/emails", {
				headers: {
					Authorization: `Bearer ${tokens.accessToken()}`,
					Accept: "application/vnd.github.v3+json",
					"User-Agent": "macrodata-mcp",
				},
			});

			if (emailsResponse.ok) {
				const emails = (await emailsResponse.json()) as Array<{
					email: string;
					primary: boolean;
				}>;
				const primary = emails.find((e) => e.primary);
				email = primary?.email ?? emails[0]?.email ?? user.login;
			} else {
				email = user.login;
			}
		}

		if (!isAllowedUser(email, c.env)) {
			console.warn(`[CALLBACK/GITHUB] Rejected user: ${email}`);
			return c.text("Access denied. Your account is not authorized to use this service.", 403);
		}

		const mcpRequest = pending.mcpOAuthRequest as Awaited<
			ReturnType<OAuthHelpers["parseAuthRequest"]>
		>;
		const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
			request: mcpRequest,
			userId: email,
			metadata: {
				provider: "github",
				email,
				login: user.login,
				name: user.name,
				authenticatedAt: new Date().toISOString(),
			},
			scope: mcpRequest.scope ?? [],
			props: {
				userId: email,
				provider: "github",
				email,
				login: user.login,
			},
		});

		await c.env.OAUTH_KV.delete(`pending:${state}`);
		return c.redirect(redirectTo);
	} catch (error) {
		console.error("[CALLBACK/GITHUB] Error:", error);
		return c.text(
			`OAuth callback error: ${error instanceof Error ? error.message : String(error)}`,
			400,
		);
	}
});

// Default handler converts Hono app to worker handler
const defaultHandler = {
	async fetch(request: Request, env: unknown, ctx: unknown) {
		return defaultApp.fetch(request, env as Env, ctx as ExecutionContext);
	},
};

// ==========================================
// API App (authenticated routes)
// ==========================================

const apiApp = new Hono<{ Bindings: Env; Variables: Variables }>();

// Settings: List connected MCPs
apiApp.get("/settings/mcps", async (c) => {
	const props = c.get("props");
	if (!props) return c.text("Unauthorized", 401);

	const userId = props.email;
	const mcpsJson = await c.env.OAUTH_KV.get(`user:${userId}:mcps`);
	const mcps: ConnectedMcp[] = mcpsJson ? JSON.parse(mcpsJson) : [];

	const status = c.req.query("status");
	const statusHtml =
		status === "connected"
			? '<div class="status status-success">MCP connected successfully!</div>'
			: status === "error"
				? `<div class="status status-error">Error: ${c.req.query("message") || "Connection failed"}</div>`
				: "";

	const mcpListHtml =
		mcps.length > 0
			? mcps
					.map(
						(mcp) => `
          <div class="mcp-item">
            <div>
              <div class="mcp-name">${escapeHtml(mcp.name)}</div>
              <div class="mcp-endpoint">${escapeHtml(mcp.endpoint)}</div>
            </div>
            <form method="POST" action="/settings/mcps/delete" style="display: inline;">
              <input type="hidden" name="name" value="${escapeHtml(mcp.name)}">
              <button type="submit" class="btn btn-danger">Remove</button>
            </form>
          </div>
        `,
					)
					.join("")
			: '<p class="empty">No MCPs connected yet.</p>';

	return c.html(
		settingsLayout(
			"Connected MCPs",
			`
    ${statusHtml}
    <div class="card">
      <h2>Your MCPs</h2>
      ${mcpListHtml}
    </div>
    <div class="card">
      <h2>Add MCP</h2>
      <form method="POST" action="/settings/mcps/add">
        <div class="form-group">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" placeholder="e.g., My GitHub MCP" required>
        </div>
        <div class="form-group">
          <label for="endpoint">Endpoint URL</label>
          <input type="url" id="endpoint" name="endpoint" placeholder="https://my-mcp.example.com" required>
        </div>
        <button type="submit" class="btn btn-primary">Connect MCP</button>
      </form>
    </div>
  `,
		),
	);
});

// Settings: Add MCP (initiate OAuth discovery and redirect)
apiApp.post("/settings/mcps/add", async (c) => {
	const props = c.get("props");
	if (!props) return c.text("Unauthorized", 401);

	const userId = props.email;
	const formData = await c.req.formData();
	const name = formData.get("name") as string;
	const endpoint = formData.get("endpoint") as string;

	if (!name || !endpoint) {
		return c.redirect(
			`${c.env.OAUTH_REDIRECT_BASE}/settings/mcps?status=error&message=Missing+name+or+endpoint`,
		);
	}

	try {
		const metadataUrl = new URL("/.well-known/oauth-authorization-server", endpoint);
		const metadataRes = await fetch(metadataUrl.toString());

		if (!metadataRes.ok) {
			throw new Error(`MCP doesn't support OAuth discovery (${metadataRes.status})`);
		}

		const metadata = (await metadataRes.json()) as {
			authorization_endpoint: string;
			token_endpoint: string;
			scopes_supported?: string[];
		};

		const state = generateState();
		const codeVerifier = generateCodeVerifier();

		const pending: PendingMcpAuth = {
			mcpName: name,
			mcpEndpoint: endpoint,
			state,
			codeVerifier,
			userId,
			createdAt: Date.now(),
		};
		await c.env.OAUTH_KV.put(
			`pending-mcp:${state}`,
			JSON.stringify({ ...pending, tokenEndpoint: metadata.token_endpoint }),
			{ expirationTtl: 600 },
		);

		const authUrl = new URL(metadata.authorization_endpoint);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("client_id", `macrodata:${userId}`);
		authUrl.searchParams.set("redirect_uri", `${c.env.OAUTH_REDIRECT_BASE}/settings/mcps/callback`);
		authUrl.searchParams.set("state", state);
		authUrl.searchParams.set("code_challenge", await generateCodeChallenge(codeVerifier));
		authUrl.searchParams.set("code_challenge_method", "S256");
		if (metadata.scopes_supported?.length) {
			authUrl.searchParams.set("scope", metadata.scopes_supported.join(" "));
		}

		return c.redirect(authUrl.toString());
	} catch (error) {
		const message = encodeURIComponent(error instanceof Error ? error.message : "Unknown error");
		return c.redirect(`${c.env.OAUTH_REDIRECT_BASE}/settings/mcps?status=error&message=${message}`);
	}
});

// Settings: OAuth callback from external MCP
apiApp.get("/settings/mcps/callback", async (c) => {
	const props = c.get("props");
	if (!props) return c.text("Unauthorized", 401);

	const code = c.req.query("code");
	const state = c.req.query("state");
	const error = c.req.query("error");

	if (error) {
		return c.redirect(
			`${c.env.OAUTH_REDIRECT_BASE}/settings/mcps?status=error&message=${encodeURIComponent(error)}`,
		);
	}

	if (!code || !state) {
		return c.redirect(
			`${c.env.OAUTH_REDIRECT_BASE}/settings/mcps?status=error&message=Missing+code+or+state`,
		);
	}

	const pendingJson = await c.env.OAUTH_KV.get(`pending-mcp:${state}`);
	if (!pendingJson) {
		return c.redirect(
			`${c.env.OAUTH_REDIRECT_BASE}/settings/mcps?status=error&message=Invalid+or+expired+state`,
		);
	}

	const pending = JSON.parse(pendingJson) as PendingMcpAuth & {
		tokenEndpoint: string;
	};

	try {
		const tokenRes = await fetch(pending.tokenEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: `${c.env.OAUTH_REDIRECT_BASE}/settings/mcps/callback`,
				client_id: `macrodata:${pending.userId}`,
				code_verifier: pending.codeVerifier,
			}),
		});

		if (!tokenRes.ok) {
			const errorText = await tokenRes.text();
			throw new Error(`Token exchange failed: ${errorText}`);
		}

		const tokens = (await tokenRes.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in?: number;
		};

		const mcpsJson = await c.env.OAUTH_KV.get(`user:${pending.userId}:mcps`);
		const mcps: ConnectedMcp[] = mcpsJson ? JSON.parse(mcpsJson) : [];

		const filtered = mcps.filter((m) => m.name !== pending.mcpName);
		filtered.push({
			name: pending.mcpName,
			endpoint: pending.mcpEndpoint,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			tokenExpiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
			connectedAt: new Date().toISOString(),
		});

		await c.env.OAUTH_KV.put(`user:${pending.userId}:mcps`, JSON.stringify(filtered));
		await c.env.OAUTH_KV.delete(`pending-mcp:${state}`);

		return c.redirect(`${c.env.OAUTH_REDIRECT_BASE}/settings/mcps?status=connected`);
	} catch (error) {
		const message = encodeURIComponent(error instanceof Error ? error.message : "Unknown error");
		return c.redirect(`${c.env.OAUTH_REDIRECT_BASE}/settings/mcps?status=error&message=${message}`);
	}
});

// Settings: Delete MCP
apiApp.post("/settings/mcps/delete", async (c) => {
	const props = c.get("props");
	if (!props) return c.text("Unauthorized", 401);

	const userId = props.email;
	const formData = await c.req.formData();
	const name = formData.get("name") as string;

	if (name) {
		const mcpsJson = await c.env.OAUTH_KV.get(`user:${userId}:mcps`);
		const mcps: ConnectedMcp[] = mcpsJson ? JSON.parse(mcpsJson) : [];
		const filtered = mcps.filter((m) => m.name !== name);
		await c.env.OAUTH_KV.put(`user:${userId}:mcps`, JSON.stringify(filtered));
	}

	return c.redirect(`${c.env.OAUTH_REDIRECT_BASE}/settings/mcps`);
});

// MCP requests - route to Durable Object
apiApp.all("/mcp/*", async (c) => {
	const props = c.get("props");
	if (!props) return c.text("Unauthorized", 401);

	console.log(`[MCP] Authenticated request from: ${props.email} (${props.provider})`);

	// Route to Durable Object via getAgentByName
	const agent = await getAgentByName<Env, MemoryAgent>(c.env.MCP_OBJECT, props.email);
	return agent.onMcpRequest(c.req.raw);
});

// Context endpoint - returns current state for daemon/hooks
// Accepts ?identity=name to use a named identity from knowledge
apiApp.get("/context", async (c) => {
	const props = c.get("props");
	if (!props) return c.text("Unauthorized", 401);

	const identityName = c.req.query("identity");
	const agent = await getAgentByName<Env, MemoryAgent>(c.env.MCP_OBJECT, props.email);
	const context = await agent.buildContextString(identityName);

	return c.text(context);
});

// WebSocket endpoint for real-time state updates
apiApp.get("/ws", async (c) => {
	const props = c.get("props");
	if (!props) return c.text("Unauthorized", 401);

	const upgradeHeader = c.req.header("Upgrade");
	if (!upgradeHeader || upgradeHeader !== "websocket") {
		return c.text("Expected WebSocket upgrade", 426);
	}

	console.log(`[WS] WebSocket upgrade request from: ${props.email}`);

	// Get DO stub directly
	const id = c.env.MCP_OBJECT.idFromName(props.email);
	const stub = c.env.MCP_OBJECT.get(id);

	// Create request with partyserver headers
	const headers = new Headers(c.req.raw.headers);
	headers.set("x-partykit-namespace", "MCP_OBJECT");
	headers.set("x-partykit-room", props.email);

	const wsRequest = new Request("https://internal/ws", {
		headers,
	});

	return stub.fetch(wsRequest);
});

// API handler converts Hono app to worker handler
const mcpApiHandler = {
	async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
		const typedEnv = env as Env;
		const typedCtx = ctx as ExecutionContext & { props?: OAuthProps };

		// Create a new app instance with props injected
		const app = new Hono<{ Bindings: Env; Variables: Variables }>();

		// Middleware to inject OAuth props
		app.use("*", async (c, next) => {
			c.set("props", typedCtx.props);
			await next();
		});

		// Mount the API routes
		app.route("/", apiApp);

		return app.fetch(request, typedEnv, typedCtx);
	},
};

// ==========================================
// Export worker
// ==========================================

const oauthProvider = new OAuthProvider({
	apiRoute: ["/mcp", "/settings", "/ws", "/context"],
	apiHandler: mcpApiHandler,
	defaultHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/oauth/token",
	clientRegistrationEndpoint: "/oauth/register",
	refreshTokenTTL: 30 * 24 * 60 * 60,
});

// Dev mode app - bypasses OAuth, uses DEV_USER as identity
const devApp = new Hono<{ Bindings: Env; Variables: Variables }>();

devApp.use("*", async (c, next) => {
	c.set("props", {
		userId: c.env.DEV_USER,
		email: c.env.DEV_USER,
		provider: "dev",
	});
	await next();
});

devApp.route("/", defaultApp);
devApp.route("/", apiApp);

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		// Dev mode: bypass OAuth when DEV_USER is set
		if (env.DEV_USER) {
			return devApp.fetch(request, env, ctx);
		}
		return oauthProvider.fetch(request, env, ctx);
	},
};
