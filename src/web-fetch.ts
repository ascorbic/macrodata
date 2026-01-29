/**
 * Web fetch using Cloudflare Browser Rendering API
 */

interface BrowserRenderingResponse {
  success: boolean;
  result?: string;
  errors?: Array<{ code: number; message: string }>;
}

/**
 * Validate URL and check for suspicious patterns
 */
export function validateUrl(urlString: string): {
  valid: boolean;
  error?: string;
  warnings: string[];
} {
  const warnings: string[] = [];

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: "Invalid URL format", warnings };
  }

  // Only allow http/https
  if (!["http:", "https:"].includes(url.protocol)) {
    return {
      valid: false,
      error: `Protocol not allowed: ${url.protocol}`,
      warnings,
    };
  }

  // Warn on long query strings (potential data exfiltration)
  if (url.search.length > 200) {
    warnings.push(
      `Long query string (${url.search.length} chars) - potential exfiltration`,
    );
  }

  // Warn on base64-like patterns in URL (encoded data)
  if (/[A-Za-z0-9+/]{50,}={0,2}/.test(urlString)) {
    warnings.push("URL contains base64-like pattern - potential encoded data");
  }

  return { valid: true, warnings };
}

/**
 * Fetch a webpage and convert to markdown using Browser Rendering API
 */
export async function fetchPageAsMarkdown(
  url: string,
  accountId: string,
  apiToken: string,
  options: { waitForSelector?: string; waitUntil?: string } = {},
): Promise<string> {
  // Validate URL before fetching
  const validation = validateUrl(url);
  if (!validation.valid) {
    throw new Error(`URL blocked: ${validation.error}`);
  }

  // Log fetch with any warnings (audit trail)
  if (validation.warnings.length > 0) {
    console.warn(`[FETCH WARNING] ${url}`, validation.warnings);
  }
  console.log(`[FETCH] ${url}`);

  const body: Record<string, unknown> = { url };

  // For JS-heavy pages, wait for network to settle
  if (options.waitUntil) {
    body.gotoOptions = { waitUntil: options.waitUntil };
  }

  // Wait for specific selector if provided
  if (options.waitForSelector) {
    body.waitForSelector = { selector: options.waitForSelector };
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Browser Rendering API error: ${response.status} - ${errorText}`,
    );
  }

  const data = (await response.json()) as BrowserRenderingResponse;

  if (!data.success) {
    const errorMsg =
      data.errors?.map((e) => e.message).join(", ") ?? "Unknown error";
    throw new Error(`Browser Rendering failed: ${errorMsg}`);
  }

  return data.result ?? "";
}
