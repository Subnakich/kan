import { z } from "zod";

export const choiceSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});
export const projectsSchema = z.object({
  items: z.array(choiceSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  demo: z.boolean().default(false),
});
export const optionsSchema = z.object({
  trackers: z.array(choiceSchema),
  statuses: z.array(choiceSchema),
  priorities: z.array(choiceSchema),
  custom_fields: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      required: z.boolean(),
      format: z.string(),
      choices: z.array(z.string()).optional(),
    }),
  ),
});
export const previewSchema = z.object({
  preview_id: z.string(),
  expires_at: z.string(),
  snapshot: z.record(z.unknown()),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});
export const exportSchema = z.object({
  operation_id: z.string(),
  status: z.enum(["pending", "created", "linked", "failed", "unknown"]),
  redmine_link: z
    .object({ display_id: z.string(), url: z.string().url() })
    .passthrough()
    .nullable(),
  errors: z.array(z.string()),
});
