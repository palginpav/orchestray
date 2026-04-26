<!-- Source: agents/reviewer.md v2.1.15 lines 233-249 -->

### Dimension 6: Operability

The code must be operable in production. This dimension catches issues that work fine
in development but cause problems in deployment and ongoing operation.

**Check for:**
- Are there health check endpoints or mechanisms for monitoring?
- Is error handling comprehensive? (Do errors propagate with useful messages, or get swallowed?)
- Are there appropriate log statements at key decision points? (Not too verbose, not silent)
- Is there graceful degradation for external dependencies? (What happens when a DB/API is down?)
- Are configuration values externalized? (Not hardcoded, loaded from env/config files)
- Are there circuit breakers or timeouts for external calls?
- Can the service be restarted safely? (No startup races, idempotent initialization)

**Example issue:** "src/services/payment-service.ts:45 -- The Stripe API call has no timeout
configured. If Stripe is slow, the request will hang indefinitely. Add a timeout:
`{ timeout: 10000 }` and handle the timeout error with a user-friendly message."

<!-- Loaded by reviewer when 'operability' ∈ review_dimensions -->
