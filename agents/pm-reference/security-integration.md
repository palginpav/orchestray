<!-- PM Reference: Loaded by Section Loading Protocol when task involves security OR security_review is "auto" and security-sensitive -->

## 24. Security Integration Protocol

### When to Invoke Security Engineer

Check `.orchestray/config.json` for `security_review` setting:
- `"auto"` (default): PM auto-invokes based on detection rules below
- `"manual"`: Only invoke when user explicitly requests security review
- `"off"`: Never invoke security-engineer

### Auto-Detection Rules (when security_review = "auto")

Invoke security-engineer when the task matches ANY of:
- **Keywords in task**: auth, login, password, token, session, JWT, OAuth, API key,
  secret, encrypt, decrypt, hash, CORS, CSRF, XSS, injection, sanitize, permission,
  role, access control, vulnerability, CVE, dependency update
- **File patterns being modified**: `**/auth/**`, `**/security/**`, `**/middleware/**`,
  `**/*auth*`, `**/*token*`, `**/*session*`, `**/*crypto*`, `**/*password*`,
  `**/api/**` (new endpoints), `package.json` (dependency changes), `requirements.txt`,
  `Cargo.toml`
- **Archetype**: Migration or Security Audit archetypes always include security review

### Invocation Modes

**Design Review (post-architect, pre-developer):**
When the architect produces a design document, spawn security-engineer with:
"Review this design for security risks. Perform threat modeling and STRIDE analysis.
Identify authentication, authorization, and data flow concerns. Report findings with
severity ratings. Design doc: [include architect's output]"

Insert security-engineer between architect and developer in the task graph.

**Implementation Audit (post-developer, parallel with reviewer):**
After developer completes, spawn security-engineer in parallel with reviewer:
"Audit the implementation for security vulnerabilities. Focus on: OWASP Top 10 checklist,
dependency scanning, secret detection, auth flow verification. Files changed: [list].
Report findings with severity and remediation."

### Model Routing for Security Engineer

- Default: Sonnet
- Opus when task involves: authentication/authorization systems, cryptographic operations,
  compliance requirements (GDPR, PCI-DSS, HIPAA), or complex multi-service security flows
- Never Haiku (security requires deep analysis)

### Integration with Verify-Fix Loop

If security-engineer reports Critical or High findings (mapped to error-severity for
verify-fix loop purposes):
1. Route findings to developer via Section 18 verify-fix loop (in tier1-orchestration.md)
2. After developer fixes, re-run security-engineer on the fixed files only
3. Cap security fix rounds at the configured `verify_fix_max_rounds` value (default 3)

### Transparency

When auto-invoking security-engineer, announce:
"Including security review (detected: {trigger reason})"
