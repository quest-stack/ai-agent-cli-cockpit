import { PROVIDER_CONVERSATION_ID, providerConversationSchema } from "./provider-conversation";

import type { ProviderConversation } from "./provider-conversation";
import type { CliCommand } from "./types";

export const CLI_LAUNCH_MODES = ["new", "resume", "continue"] as const;
export type CliLaunchMode = (typeof CLI_LAUNCH_MODES)[number];

interface CliInvocation { cli: CliCommand; mode: CliLaunchMode; conversationId?: string }

export function createCliLaunchCommand(cli: string, mode: CliLaunchMode): string {
  if (cli === "claude") return mode === "resume" ? "claude --resume" : mode === "continue" ? "claude --continue" : cli;
  if (cli === "codex") return mode === "resume" ? "codex resume" : mode === "continue" ? "codex resume --last" : cli;
  return cli;
}

const invocations = new Map<string, CliInvocation>();
for (const cli of ["claude", "codex", "powershell", "shell"] as const) {
  for (const mode of cli === "claude" || cli === "codex" ? CLI_LAUNCH_MODES : ["new"] as const) {
    invocations.set(createCliLaunchCommand(cli, mode), { cli, mode });
  }
}
invocations.set("claude -c", { cli: "claude", mode: "continue" });
invocations.set("claude -r", { cli: "claude", mode: "resume" });

export function getCliInvocation(command: string | undefined): CliInvocation | undefined {
  if (command === undefined) return undefined;
  const text = command.trim();
  const known = invocations.get(text);
  if (known) return known;
  const exact = new RegExp(`^(claude --resume|codex resume) (${PROVIDER_CONVERSATION_ID})$`, "iu").exec(text);
  return exact ? { cli: exact[1].toLowerCase().startsWith("claude") ? "claude" : "codex", mode: "resume", conversationId: exact[2] } : undefined;
}

export function getCliKind(command: string | undefined): CliCommand | undefined {
  return getCliInvocation(command)?.cli;
}

/** Reopen the recorded conversation, never the latest conversation in a cwd. */
export function getConversationResumeCommand(command: string, conversation: ProviderConversation): string | undefined {
  const parsed = providerConversationSchema.safeParse(conversation);
  if (!parsed.success || getCliKind(command) !== parsed.data.cli) return undefined;
  return `${createCliLaunchCommand(parsed.data.cli, "resume")} ${parsed.data.id}`;
}

export function getRestoredCliCommand(command: string, conversation: ProviderConversation | null | undefined): string {
  if (conversation) {
    const exact = getConversationResumeCommand(command, conversation);
    if (!exact) throw new Error("Saved conversation does not match this CLI.");
    return exact;
  }
  const invocation = getCliInvocation(command);
  if (invocation?.conversationId || !invocation) return command;
  // Unknown/null identities do not prove that the previous conversation was
  // empty. Restoration must never silently start a new conversation.
  // Legacy workspaces have no conversation mapping. Ask the CLI to choose;
  // never silently attach every tab in a folder to the same latest thread.
  return invocation.cli === "claude" || invocation.cli === "codex"
    ? createCliLaunchCommand(invocation.cli, "resume") : command;
}
