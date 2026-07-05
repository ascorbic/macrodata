/**
 * Tests for the remote (OpenAI-compatible) embedding provider.
 *
 * A mock Bun HTTP server plays the embeddings API so the tests verify the
 * real request/response wire format without network access. Local-model
 * fallback paths are covered by the existing indexer tests.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  embed,
  embedBatch,
  embedQuery,
  getRemoteEmbeddingConfig,
  resetEmbeddingConfigCache,
} from "../src/embeddings";

interface RecordedRequest {
  url: string;
  authorization: string | null;
  body: {
    model: string;
    input: string[];
    input_type?: string;
  };
}

const recordedRequests: RecordedRequest[] = [];
let respondWith: (input: string[]) => Response = defaultResponder;

function defaultResponder(input: string[]): Response {
  return Response.json({
    object: "list",
    data: input.map((_, index) => ({
      object: "embedding",
      index,
      embedding: [0.1 * (index + 1), 0.2, 0.3],
    })),
    model: "test-model",
  });
}

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const body = (await req.json()) as RecordedRequest["body"];
    recordedRequests.push({
      url: req.url,
      authorization: req.headers.get("authorization"),
      body,
    });
    return respondWith(body.input);
  },
});

const ENDPOINT = `http://localhost:${server.port}/v1`;

let configDir: string;

function writeConfig(embedding: Record<string, unknown> | null) {
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify(embedding ? { embedding } : {}));
  process.env.MACRODATA_CONFIG_PATH = configPath;
  resetEmbeddingConfigCache();
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "macrodata-embed-test-"));
  recordedRequests.length = 0;
  respondWith = defaultResponder;
});

afterEach(() => {
  delete process.env.MACRODATA_CONFIG_PATH;
  resetEmbeddingConfigCache();
  rmSync(configDir, { recursive: true, force: true });
});

afterAll(() => {
  server.stop(true);
});

describe("getRemoteEmbeddingConfig", () => {
  test("returns null when config.json is absent", () => {
    process.env.MACRODATA_CONFIG_PATH = join(configDir, "missing.json");
    resetEmbeddingConfigCache();
    expect(getRemoteEmbeddingConfig()).toBeNull();
  });

  test("returns null when embedding block is absent", () => {
    writeConfig(null);
    expect(getRemoteEmbeddingConfig()).toBeNull();
  });

  test("returns null for unknown providers", () => {
    writeConfig({ provider: "mystery", endpoint: ENDPOINT, model: "m" });
    expect(getRemoteEmbeddingConfig()).toBeNull();
  });

  test("returns null when required fields are missing", () => {
    writeConfig({ provider: "openai-compatible", model: "m" });
    expect(getRemoteEmbeddingConfig()).toBeNull();
  });

  test("parses a valid openai-compatible config", () => {
    writeConfig({
      provider: "openai-compatible",
      endpoint: ENDPOINT,
      api_key: "sk-test",
      model: "test-model",
    });
    const config = getRemoteEmbeddingConfig();
    expect(config).not.toBeNull();
    expect(config?.endpoint).toBe(ENDPOINT);
    expect(config?.model).toBe("test-model");
  });
});

describe("remote embedding requests", () => {
  beforeEach(() => {
    writeConfig({
      provider: "openai-compatible",
      endpoint: ENDPOINT,
      api_key: "sk-test",
      model: "test-model",
      input_type: "passage",
      query_input_type: "query",
    });
  });

  test("embed posts to /embeddings with auth and model", async () => {
    const vector = await embed("hello");

    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(recordedRequests).toHaveLength(1);
    const req = recordedRequests[0];
    expect(req.url).toEndWith("/v1/embeddings");
    expect(req.authorization).toBe("Bearer sk-test");
    expect(req.body.model).toBe("test-model");
    expect(req.body.input).toEqual(["hello"]);
    expect(req.body.input_type).toBe("passage");
  });

  test("embedQuery uses query_input_type", async () => {
    await embedQuery("find me things");

    expect(recordedRequests).toHaveLength(1);
    expect(recordedRequests[0].body.input_type).toBe("query");
  });

  test("embedBatch splits into configured batch sizes", async () => {
    writeConfig({
      provider: "openai-compatible",
      endpoint: ENDPOINT,
      api_key: "sk-test",
      model: "test-model",
      batch_size: 2,
    });

    const texts = ["a", "b", "c", "d", "e"];
    const vectors = await embedBatch(texts);

    expect(vectors).toHaveLength(5);
    expect(recordedRequests).toHaveLength(3);
    expect(recordedRequests.map((r) => r.body.input)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  test("restores response order using the index field", async () => {
    respondWith = (input) =>
      Response.json({
        data: input
          .map((_, index) => ({ index, embedding: [index + 1, 0, 0] }))
          .reverse(),
      });

    const vectors = await embedBatch(["first", "second"]);

    expect(vectors[0][0]).toBe(1);
    expect(vectors[1][0]).toBe(2);
  });

  test("resolves api key from api_key_env when set", async () => {
    process.env.MACRODATA_TEST_EMBED_KEY = "sk-from-env";
    writeConfig({
      provider: "openai-compatible",
      endpoint: ENDPOINT,
      api_key: "sk-fallback",
      api_key_env: "MACRODATA_TEST_EMBED_KEY",
      model: "test-model",
    });

    await embed("hello");

    expect(recordedRequests[0].authorization).toBe("Bearer sk-from-env");
    delete process.env.MACRODATA_TEST_EMBED_KEY;
  });

  test("throws on HTTP errors instead of returning bad vectors", async () => {
    respondWith = () => new Response("upstream exploded", { status: 502 });

    await expect(embed("hello")).rejects.toThrow(/502/);
  });

  test("throws when the response count does not match the input count", async () => {
    respondWith = () => Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] });

    await expect(embedBatch(["a", "b"])).rejects.toThrow(/mismatch/);
  });

  test("embedBatch returns empty array without any request", async () => {
    const vectors = await embedBatch([]);
    expect(vectors).toEqual([]);
    expect(recordedRequests).toHaveLength(0);
  });

  test("merges extra_body fields into the request payload", async () => {
    writeConfig({
      provider: "openai-compatible",
      endpoint: ENDPOINT,
      api_key: "sk-test",
      model: "test-model",
      extra_body: { truncate: "END" },
    });

    await embed("hello");

    expect(recordedRequests).toHaveLength(1);
    expect((recordedRequests[0].body as Record<string, unknown>).truncate).toBe("END");
    expect(recordedRequests[0].body.model).toBe("test-model");
  });
});
