# Security Specification (TDD) - Aferição de Retorno de Rota

## Data Invariants
1. **Durable Scope Isolation**: All application data must reside strictly within the `/app_state` collection, matching verified document IDs (`users`, `drivers`, `vehicles`, `products`, `activeAssets`, `audits`, `vales`, `returnForecasts`, `fiscalAlerts`, `importedRoutes`, `photos`).
2. **Strict Identity Constraints**: No anonymous writes or reads are allowed. Any requester must be authenticated and have their email verified (`request.auth.token.email_verified == true`).
3. **Structure Integrity**: The stored data under any document must strictly contain a `data` key, which must be a list of records.

## The Dirty Dozen Payloads
Below are 12 specific payloads or operations designed to violate security or bypass data structures, which must be rejected:

1. **Anonymous Read Attempt**: Try to read `/app_state/users` without authentication.
2. **Anonymous Write Attempt**: Try to create a document at `/app_state/malicious` without authentication.
3. **Unverified Email Read Attempt**: Try to read `/app_state/audits` with a mock user whose `email_verified` is false.
4. **Invalid Document ID Poisoning**: Write to `/app_state/some_extremely_long_junk_id_poisoning_the_database_with_garbage_records`.
5. **No Data Key (Structure Bypass)**: Attempt to update `/app_state/products` with an empty object `{}` lacking the `data` key.
6. **Mismatched Type for Data Key**: Attempt to update `/app_state/vehicles` with `{ "data": "not-an-array" }`.
7. **Privilege Escalation (Role Injection)**: Attempt to write to `/app_state/users` setting self as Admin directly.
8. **Malicious Empty File Overwrite**: Try to overwrite `/app_state/audits` with null data.
9. **Spamming Arbitrary Collections**: Attempt to write to `/some_random_unauthorized_collection/doc` directly.
10. **Hijacking PII / Emails**: Read user collection private data as an unauthenticated or invalid user.
11. **Bypassing Server Timestamps**: Attempt to write arbitrary client timestamps to system-sensitive alerts.
12. **Status Shortcut / Terminal Locking**: Try to write over a finalized audit with fake physical counts once finalized.

## Test Runner (firestore.rules.test.ts Mockup)
```typescript
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';

describe('Firestore Security Rules Test', () => {
  it('should deny anonymous reads', async () => {
    // ... test implementation
  });
  // ... other "Dirty Dozen" checks
});
```
