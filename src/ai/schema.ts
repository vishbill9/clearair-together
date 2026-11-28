import { z } from 'zod';

const effectSchema = z.enum(['lower', 'similar', 'higher', 'unknown']);
const effortSchema = z.enum(['low', 'medium', 'high']);

export const assistantOutputSchema = z
  .object({
    directAnswer: z.string().min(1).max(1200),
    recommendedActions: z
      .array(
        z
          .object({
            title: z.string().min(1).max(100),
            detail: z.string().min(1).max(400),
            effort: effortSchema,
          })
          .strict(),
      )
      .max(6),
    effortLevel: effortSchema,
    rationale: z.string().min(1).max(800),
    feasibleAlternative: z.string().max(500),
    exposureOpportunity: effectSchema,
    emissionsOpportunity: effectSchema,
    assumptions: z.array(z.string().min(1).max(240)).max(8),
    safetyNotice: z.string().max(400).nullable(),
    sources: z.array(z.object({ id: z.string().min(1).max(60) }).strict()).max(6),
    uncertainty: z.string().min(1).max(500),
  })
  .strict();

export type AssistantOutput = z.infer<typeof assistantOutputSchema>;

export const assistantRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(800),
    householdId: z.uuid().optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    languageCode: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/)
      .default('en'),
  })
  .strict();

/** JSON schema text embedded in the system prompt so the model knows the exact contract. */
export const OUTPUT_CONTRACT = `{
  "directAnswer": string,
  "recommendedActions": [{"title": string, "detail": string, "effort": "low"|"medium"|"high"}],
  "effortLevel": "low"|"medium"|"high",
  "rationale": string,
  "feasibleAlternative": string,
  "exposureOpportunity": "lower"|"similar"|"higher"|"unknown",
  "emissionsOpportunity": "lower"|"similar"|"higher"|"unknown",
  "assumptions": [string],
  "safetyNotice": string|null,
  "sources": [{"id": string}],
  "uncertainty": string
}`;
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;
