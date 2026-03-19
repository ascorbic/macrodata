import { createReadStream, existsSync, readdirSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

export interface JsonlReadStats {
  totalLines: number;
  parsedLines: number;
  malformedLines: number;
}

interface ListJsonlFilesOptions {
  descending?: boolean;
}

interface ReadJsonlFileOptions<T> {
  onItem: (item: T, lineNumber: number) => void;
  onMalformedLine?: (lineNumber: number, rawLine: string, error: unknown) => void;
}

export function listJsonlFiles(dirPath: string, options: ListJsonlFilesOptions = {}): string[] {
  if (!existsSync(dirPath)) {
    return [];
  }

  const files = readdirSync(dirPath)
    .filter((file) => file.endsWith(".jsonl"))
    .sort();

  if (options.descending) {
    files.reverse();
  }

  return files;
}

export async function readJsonlFile<T>(
  filePath: string,
  options: ReadJsonlFileOptions<T>
): Promise<JsonlReadStats> {
  const input = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input, crlfDelay: Infinity });

  let totalLines = 0;
  let parsedLines = 0;
  let malformedLines = 0;

  try {
    for await (const line of rl) {
      const rawLine = line.trim();
      if (!rawLine) {
        continue;
      }

      totalLines += 1;

      try {
        const parsed = JSON.parse(rawLine) as T;
        options.onItem(parsed, totalLines);
        parsedLines += 1;
      } catch (error) {
        malformedLines += 1;
        options.onMalformedLine?.(totalLines, rawLine, error);
      }
    }
  } finally {
    rl.close();
    input.close();
  }

  return {
    totalLines,
    parsedLines,
    malformedLines,
  };
}

export function resolveJsonlPath(dirPath: string, fileName: string): string {
  return join(dirPath, fileName);
}
