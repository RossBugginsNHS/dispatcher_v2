import { parseDispatchingConfig, type DispatchingConfig } from "../domain/dispatching-schema/schema.js";

export const DISPATCHING_CONFIG_PATHS = ["dispatching.yml", ".github/dispatching.yml"];

export type FetchDispatchingConfigResult =
  | { found: true; config: DispatchingConfig }
  | { found: false; reason: "missing" | "invalid"; error?: unknown };

export interface RepoContentsClient {
  repos: {
    getContent(params: {
      owner: string;
      repo: string;
      path: string;
    }): Promise<{
      data: { type: string; content: string; encoding: string } | unknown[];
    }>;
  };
}

export async function fetchDispatchingConfig(
  client: RepoContentsClient,
  owner: string,
  repo: string,
): Promise<FetchDispatchingConfigResult> {
  let rawContent: string | undefined;

  for (const path of DISPATCHING_CONFIG_PATHS) {
    try {
      const response = await client.repos.getContent({
        owner,
        repo,
        path,
      });

      const data = response.data;

      if (Array.isArray(data)) {
        continue;
      }

      const file = data as { type: string; content: string; encoding: string };

      if (file.type !== "file") {
        continue;
      }

      rawContent = Buffer.from(file.content, "base64").toString("utf-8");
      break;
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        continue;
      }
      throw error;
    }
  }

  if (!rawContent) {
    return { found: false, reason: "missing" };
  }

  try {
    const config = parseDispatchingConfig(rawContent);
    return { found: true, config };
  } catch (error: unknown) {
    return { found: false, reason: "invalid", error };
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: number }).status === 404
  );
}
