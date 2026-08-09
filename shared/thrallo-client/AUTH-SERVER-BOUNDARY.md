# Native authentication server boundary

D2 implements only the native client and deterministic development provider. It does not mount a
route, define a production token format, or assume that an authorization server contract exists.
The future server adapter remains capability-unavailable until separately approved.

The following contracts are deliberately unresolved:

- browser authorization initiation, consent, redirect and one-time exchange endpoints;
- opaque access/session and rotating refresh material formats and clock-skew rules;
- authoritative account and device binding, device naming and revocation semantics;
- refresh-reuse detection error vocabulary and recovery behavior;
- approved callback error codes, authorization expiry and account-switch policy;
- server capability negotiation and billing/entitlement effects on device sessions;
- the approved mapping from opaque device-session material to D1 request authentication headers;
  D2 deliberately does not assume a bearer-token wire format.

Any later adapter must implement the narrow `NativeAuthProvider` boundary, return opaque session
material, reject account/device mismatches, rotate refresh material, and fail closed when its
capability is unavailable. It must not add a fixture-to-production fallback.
