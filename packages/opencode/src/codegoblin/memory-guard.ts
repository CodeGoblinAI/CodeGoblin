// Lightweight prompt-injection / threat scan for memory content.
//
// Ported (in spirit) from two of the reference repos studied for this pass:
//   - Hermes: scans memory before it is frozen into the system prompt so a
//     malicious recalled fact cannot hijack a later turn.
//   - ECC ("Every Command Counts"): defense-in-depth pattern matching for
//     instruction-override and exfiltration attempts.
//
// This is intentionally simple and conservative: it returns a human-readable
// reason string when content looks dangerous, or `undefined` when it is clean.
// Memory is authoritative once injected, so we reject obvious attempts to
// smuggle new instructions into it rather than trying to sanitize them.

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

/**
 * Returns a reason string if the content matches a known threat pattern, or
 * `undefined` when the content is considered safe to store and recall.
 */
export function scanMemoryContent(content: string): string | undefined {
  for (const { pattern, reason } of THREAT_PATTERNS) {
    if (pattern.test(content)) return reason
  }
  return undefined
}
