// Command-level policy for the agent's run_command tool.
//
// standard: current behavior — any non-interactive command inside the disposable sandbox.
// restricted: blocks commands whose primary purpose is network transfer, remote shells,
// privilege escalation, or package publication. Blocked commands return a policy error to
// the model (the run continues); the timeline records every refusal.
//
// This governs the commercial tool loop only. Codex subscription runs execute Codex's own
// tooling inside the sandbox, where the network policy (not this list) is the boundary.

const RESTRICTED_PATTERNS = [
  { name: "network_transfer", pattern: /(?:^|[\s;|&(])(?:curl|wget|nc|ncat|netcat|socat|telnet|ftp)\b/i },
  { name: "remote_shell", pattern: /(?:^|[\s;|&(])(?:ssh|scp|sftp|rsync)\b/i },
  { name: "privilege_escalation", pattern: /(?:^|[\s;|&(])(?:sudo|su|doas)\b/i },
  { name: "package_publish", pattern: /\b(?:npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bcargo\s+publish\b/i },
  { name: "mail", pattern: /(?:^|[\s;|&(])(?:mail|sendmail|mutt)\b/i },
  { name: "dns_exfil", pattern: /(?:^|[\s;|&(])(?:dig|nslookup|host)\b/i },
];

// Always refused regardless of policy: publishing artifacts from inside the sandbox would
// bypass the approval gate entirely.
const ALWAYS_BLOCKED = [
  { name: "package_publish", pattern: /\b(?:npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bcargo\s+publish\b/i },
  { name: "git_push", pattern: /\bgit\s+(?:[\w-]+\s+)*push\b/i },
];

export function evaluateCommand(commandPolicy, command) {
  const text = String(command || "");
  for (const rule of ALWAYS_BLOCKED) {
    if (rule.pattern.test(text)) {
      return blocked(rule.name, "Publishing from inside the workspace is not allowed; finish the task and let Thrallo open the pull request.");
    }
  }
  if (commandPolicy !== "restricted") return { allowed: true };
  for (const rule of RESTRICTED_PATTERNS) {
    if (rule.pattern.test(text)) {
      return blocked(rule.name, `This agent's restricted command policy blocks ${rule.name.replaceAll("_", " ")} commands. Work with the repository contents instead.`);
    }
  }
  return { allowed: true };
}

function blocked(rule, message) {
  return { allowed: false, rule, message };
}
