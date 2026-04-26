<!-- Source: agents/reviewer.md v2.1.15 lines 251-267 -->

### Dimension 7: API Compatibility

The code must not introduce breaking changes to public interfaces without explicit
versioning and migration support.

**Check for:**
- Are any public API endpoints, function signatures, or exported types changed in
  backwards-incompatible ways?
- Are removed or renamed fields/endpoints accompanied by deprecation notices?
- Do configuration file format changes have migration support?
- Are database schema changes backwards-compatible with rolling deployments?
- Are there version bumps appropriate to the change scope (semver)?
- Are client-facing error formats consistent with existing patterns?

**Example issue:** "src/api/users.ts:12 -- The response field `user_name` was renamed to
`username` without a deprecation period. Existing API consumers will break. Either: (a) keep
both fields for one version, or (b) bump the API version and document the breaking change."

<!-- Loaded by reviewer when 'api-compat' ∈ review_dimensions -->
