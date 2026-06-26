import { agentRunner, agentUser, sudoBin } from "./config.js";

export function agentCommand(command: string, args: string[]): { command: string; args: string[] } {
  return {
    command: sudoBin,
    args: ["-E", "-H", "-u", agentUser, "--", agentRunner, command, ...args]
  };
}
