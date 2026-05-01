export type SourceContext = {
  sha: string;
  head_branch: string;
  run_id: string;
  run_url: string;
  repo: string;
  workflow: string;
};

const TEMPLATE_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

const MAX_INPUT_VALUE_LENGTH = 1024;

const SUPPORTED_VARIABLES = new Set([
  "source.sha",
  "source.head_branch",
  "source.run_id",
  "source.run_url",
  "source.repo",
  "source.workflow",
]);

function resolveVariable(variable: string, context: SourceContext): string {
  switch (variable) {
    case "source.sha":
      return context.sha;
    case "source.head_branch":
      return context.head_branch;
    case "source.run_id":
      return context.run_id;
    case "source.run_url":
      return context.run_url;
    case "source.repo":
      return context.repo;
    case "source.workflow":
      return context.workflow;
    default:
      throw new Error(`Unknown template variable "{{ ${variable} }}"`);
  }
}

function sanitizeInputValue(key: string, value: string): { sanitized: string } | { error: string } {
  if (value.length > MAX_INPUT_VALUE_LENGTH) {
    return {
      error: `Resolved value for input "${key}" exceeds the maximum length of ${MAX_INPUT_VALUE_LENGTH} characters`,
    };
  }
  // Reject control characters (newlines, null bytes, etc.) which could enable log injection
  // or break downstream YAML/JSON handling. Printable ASCII and Unicode are permitted.
  if (/[\x00-\x1F\x7F]/.test(value)) {
    return { error: `Resolved value for input "${key}" contains disallowed control characters` };
  }
  return { sanitized: value };
}

/**
 * Resolves template inputs against the provided source context.
 *
 * Template syntax: `{{ source.variable }}`
 * Supported variables: source.sha, source.head_branch, source.run_id, source.run_url,
 * source.repo, source.workflow.
 *
 * Literal string values (no template markers) are passed through unchanged.
 * Unknown template variables or unsafe resolved values cause an error to be returned.
 */
export function resolveInputs(
  templateInputs: Record<string, string>,
  context: SourceContext,
): { resolved: Record<string, string> } | { error: string } {
  const resolved: Record<string, string> = {};

  for (const [key, template] of Object.entries(templateInputs)) {
    // Detect unknown template variables before substitution
    for (const match of template.matchAll(TEMPLATE_PATTERN)) {
      const variable = match[1].trim();
      if (!SUPPORTED_VARIABLES.has(variable)) {
        return {
          error: `Unknown template variable "{{ ${variable} }}" in input "${key}". Supported variables: ${[...SUPPORTED_VARIABLES].join(", ")}`,
        };
      }
    }

    // Substitute known variables
    let resolvedValue: string;
    try {
      resolvedValue = template.replace(TEMPLATE_PATTERN, (_full, variable: string) =>
        resolveVariable(variable.trim(), context),
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }

    // Sanitize the resolved value
    const sanitizeResult = sanitizeInputValue(key, resolvedValue);
    if ("error" in sanitizeResult) {
      return { error: sanitizeResult.error };
    }

    resolved[key] = sanitizeResult.sanitized;
  }

  return { resolved };
}
