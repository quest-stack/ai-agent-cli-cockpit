import { z } from "zod";

export const PROVIDER_CONVERSATION_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const providerConversationIdSchema = z.string().regex(new RegExp(`^${PROVIDER_CONVERSATION_ID}$`, "iu"));
export const providerConversationSchema = z.object({
  cli: z.enum(["claude", "codex"]),
  id: providerConversationIdSchema,
});
export type ProviderConversation = z.infer<typeof providerConversationSchema>;
