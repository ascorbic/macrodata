/**
 * Web search tools using Brave Search API
 */

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

interface BraveSearchResponse {
  web?: {
    results: Array<{
      title: string;
      url: string;
      description: string;
      age?: string;
    }>;
  };
  news?: {
    results: Array<{
      title: string;
      url: string;
      description: string;
      age?: string;
    }>;
  };
}

/**
 * Search the web using Brave Search API
 */
export async function searchWeb(
  query: string,
  apiKey: string,
  options: { count?: number; freshness?: string } = {},
): Promise<BraveSearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(options.count ?? 5),
  });

  if (options.freshness) {
    params.set("freshness", options.freshness);
  }

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status}`);
  }

  const data = (await response.json()) as BraveSearchResponse;

  return (
    data.web?.results.map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
      age: r.age,
    })) ?? []
  );
}

/**
 * Search news using Brave Search API
 */
export async function searchNews(
  query: string,
  apiKey: string,
  options: { count?: number; freshness?: string } = {},
): Promise<BraveSearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(options.count ?? 5),
  });

  if (options.freshness) {
    params.set("freshness", options.freshness);
  }

  const response = await fetch(
    `https://api.search.brave.com/res/v1/news/search?${params}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status}`);
  }

  const data = (await response.json()) as { results?: BraveSearchResult[] };

  return (
    data.results?.map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
      age: r.age,
    })) ?? []
  );
}
