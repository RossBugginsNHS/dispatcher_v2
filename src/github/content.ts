import { parseDispatchingConfig, type DispatchingConfig } from "../domain/dispatching-schema/schema.js";

export const DISPATCHING_CONFIG_PATH = ".github/dispatching.yml";

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
  let rawContent: string;

  try {
    const response = await client.repos.getContent({
      owner,
      repo,
      path: DISPATCHING_CONFIG_PATH,
    });

    const data = response.data;

    if (Array.isArray(data)) {
      return { found: false, reason: "missing" };
    }

    const file = data as { type: string; content: string; encoding: string };

    if (file.type !== "file") {
      return { found: false, reason: "missing" };
    }

    rawContent = Buffer.from(file.content, "base64").toString("utf-8");
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return { found: false, reason: "missing" };
    }
    throw error;
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
