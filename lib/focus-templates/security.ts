// Derived from https://github.com/anthropics/claude-code-security-review/blob/0c6a49f1fa56a1d472575da86a94dbc1edb78eda/claudecode/prompts.py and .claude/commands/security-review.md @ 0c6a49f1fa56a1d472575da86a94dbc1edb78eda.
// Licensed under MIT. See THIRD_PARTY_NOTICES.md.
// Changed: retained categories, methodology, exclusions and false-positive precedents; removed CI, schema, output and sub-task idioms; mapped severity and dropped LOW; qualified memory-safety exclusion for unsafe code and foreign interfaces.
export const security = {
  id: "security",
  label: "Security",
  description: "Find concrete, exploitable vulnerabilities introduced by the change.",
  source: "https://github.com/anthropics/claude-code-security-review/blob/0c6a49f1fa56a1d472575da86a94dbc1edb78eda/claudecode/prompts.py",
  sourceSha: "0c6a49f1fa56a1d472575da86a94dbc1edb78eda",
  license: "MIT",
  holder: "Copyright (c) 2025 Anthropic",
  instructions: `Perform a security-focused review of vulnerabilities newly introduced by the diff, including newly reachable exploitation of existing code. Skip pre-existing security concerns. Focus only on high-confidence vulnerabilities with real exploitation potential, not general code quality or hardening advice.

Minimize false positives: require greater than 80% confidence in actual exploitability and a clear attack path. Prioritize unauthorized access, data breaches and system compromise. A familiar suspicious pattern alone is insufficient.

Examine these categories:
- Input validation: SQL, command, XML external entity, template and NoSQL injection; path traversal.
- Authentication and authorization: authentication bypass, privilege escalation, session flaws, token vulnerabilities and authorization bypasses.
- Cryptography and secrets: hardcoded credentials where not excluded below, weak cryptography, improper key management, insecure randomness and certificate validation bypasses.
- Injection and execution: unsafe deserialization, including pickle and YAML; dynamic evaluation; reflected, stored and DOM-based XSS.
- Data exposure: sensitive logging, personally identifiable information (PII), endpoint leaks and debug disclosure, subject to the exclusions below.

Method:
1. Understand existing security libraries, secure coding patterns, sanitization and validation, and the project's security and threat model.
2. Compare changed code with those patterns. Investigate deviations and new attack surfaces, but do not flag a deviation without an exploit.
3. Trace attacker-controlled inputs to sensitive operations, unsafe deserialization and privilege boundaries. Check callers and defenses that could invalidate the candidate.
4. Independently recheck each candidate against every exclusion and precedent below. Code reading is enough; do not execute exploit payloads. Describe the attacker's control, required conditions, security consequence and smallest effective correction.

Hard exclusions — do not report:
1. Denial of service, resource exhaustion, memory or CPU exhaustion, service overload, rate limiting, or resource leaks such as memory/file descriptors.
2. Secrets, credentials or sensitive data stored on disk; these are handled separately. Do not turn the broad category list into disk-storage findings.
3. Missing validation of non-security-critical fields without proven security impact.
4. Workflow input sanitization concerns without a concrete path from untrusted input.
5. Missing hardening measures or best practices without a concrete vulnerability.
6. Theoretical race conditions or timing attacks without a practical, problematic attack path.
7. Outdated third-party library vulnerabilities; these are managed separately.
8. Alleged buffer overflows or use-after-free in ordinary memory-safe code. Do not assume unsafe blocks or foreign interfaces have the same guarantees; establish an actual unsafe path before considering them.
9. Files only used for unit tests or running tests.
10. Log spoofing: unsanitized log text alone is not a vulnerability.
11. SSRF where an attacker controls only the path, not host or protocol.
12. User-controlled content in AI system prompts, by itself.
13. Regex injection or regex denial of service.
14. Documentation files, including Markdown.
15. Missing audit logs.

False-positive precedents:
- Plaintext logging of high-value secrets is a vulnerability. Assume URL logging is safe; non-PII logging is not a finding merely because data may be sensitive. Report logging only when it exposes secrets, passwords or PII.
- Assume UUIDs are unguessable; do not demand validation just for that reason.
- Environment variables and command-line flags are trusted configuration in a secure environment. Exclude attacks relying on an attacker changing them.
- Subtle or low-impact web issues such as tabnabbing, XS-Leaks, prototype pollution and open redirects require extremely high confidence before consideration, and must still meet the impact threshold below.
- React and Angular normally escape rendered data. Do not report XSS in components or typed component files without unsafe rendering such as dangerouslySetInnerHTML, bypassSecurityTrustHtml or an equivalent bypass.
- Workflow vulnerabilities are usually not exploitable: require a concrete, specific untrusted-input attack path.
- Missing client-side authentication or authorization checks in JavaScript/TypeScript are not vulnerabilities. Enforcement belongs on the server; trace backend validation before alleging a bypass.
- Notebook vulnerabilities require a concrete, specific path where untrusted input triggers exploitation.
- Shell command injection requires a concrete path from untrusted user input; do not assume shell scripts receive it.
- Only include conditional-impact findings when obvious and concrete, not merely plausible.

Signal quality: is there a concrete exploit and clear attack path, a real security risk rather than a theoretical best practice, a specific location and reproducible scenario, and an actionable correction? Drop candidates that cannot pass this check. Confidence in an exploit is separate from its severity.

Map upstream HIGH (directly exploitable remote execution, data breach or authentication bypass) to Blocking when the confirmed impact makes merging unsafe. Map MEDIUM (specific conditions but significant impact) to Should fix only when those conditions and consequences are concrete. Drop LOW defense-in-depth and low-impact issues rather than inflating them. Local-network-only exploitation can still justify Blocking; network proximity alone does not reduce impact.`,
} as const;
