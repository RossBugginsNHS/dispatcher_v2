import { parse as parseYaml } from "yaml";
import { z } from "zod";

const OutboundTargetSchema = z.object({
  repository: z.string().min(1),
  workflow: z.string().min(1),
  ref: z.string().min(1).optional(),
}).strict();

const OutboundRuleSchema = z.object({
  source: z.object({
    workflow: z.string().min(1),
  }).strict(),
  targets: z.array(OutboundTargetSchema).min(1),
}).strict();

const InboundTargetSchema = z.object({
  workflow: z.string().min(1),
}).strict();

const InboundRuleSchema = z.object({
  source: z.object({
    repository: z.string().min(1),
    workflow: z.string().min(1),
  }).strict(),
  targets: z.array(InboundTargetSchema).min(1),
}).strict();

export const DispatchingConfigSchema = z.object({
  outbound: z.array(OutboundRuleSchema).default([]),
  inbound: z.array(InboundRuleSchema).default([]),
}).strict();

export type DispatchingConfig = z.infer<typeof DispatchingConfigSchema>;
export type OutboundRule = z.infer<typeof OutboundRuleSchema>;
export type InboundRule = z.infer<typeof InboundRuleSchema>;

export function parseDispatchingConfig(rawYaml: string): DispatchingConfig {
  const parsed: unknown = parseYaml(rawYaml, { uniqueKeys: true, merge: false });
  return DispatchingConfigSchema.parse(parsed);
}
