const THREAT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)\b/i,
    reason: "contains an instruction-override phrase",
  },
  {
    pattern: /\bdisregard\s+(all\s+)?(previous|prior|the\s+above|your)\s+(instructions|rules|guidelines)\b/i,
    reason: "contains an instruction-override phrase",
  },
  {
    pattern: /\b(you\s+are\s+now|from\s+now\s+on,?\s+you\s+are)\b.*\b(jailbroken|developer\s+mode|unrestricted)\b/i,
    reason: "attempts to reassign the assistant's role",
  },
  {
    pattern: /<\s*\/?\s*(system|system-reminder|memory-context)\s*>/i,
    reason: "tries to forge a system/context tag",
  },
  {
    pattern: /\b(exfiltrate|leak|send)\b.*\b(api[_\s-]?key|secret|password|token|credentials?)\b/i,
    reason: "looks like a credential-exfiltration instruction",
  },
  {
    pattern: /\b(curl|wget|fetch)\b.*\b(\$\{?[A-Z_]+\}?|env|secret|token)\b/i,
    reason: "looks like an exfiltration command",
  },
]

export function scanMemoryContent(content: string): string | undefined {
  for (const { pattern, reason } of THREAT_PATTERNS) {
    if (pattern.test(content)) return reason
  }
  return undefined
}
