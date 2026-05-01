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
  let value: string;
  switch (variable) {
    case "source.sha":
      value = context.sha;
      break;
    case "source.head_branch":
      value = context.head_branch;
      break;
    case "source.run_id":
      value = context.run_id;
      break;
    case "source.run_url":
      value = context.run_url;
      break;
    case "source.repo":
      value = context.repo;
      break;
    case "source.workflow":
      value = context.workflow;
      break;
    default:
      throw new Error(`Unknown template variable "{{ ${variable} }}"`);
  }

  if (value === "") {
    throw new Error(
      `Template variable "{{ ${variable} }}" resolved to an empty string; the source field may not be available for this event type`,
    );
  }

  return value;
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
      const variable = match[1];
      if (variable === undefined) continue;
      if (!SUPPORTED_VARIABLES.has(variable.trim())) {
        return {
          error: `Unknown template variable "{{ ${variable.trim()} }}" in input "${key}". Supported variables: ${[...SUPPORTED_VARIABLES].join(", ")}`,
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
