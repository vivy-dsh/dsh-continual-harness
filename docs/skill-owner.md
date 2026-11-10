# Skill Owner deployment

Skill Owner stores staged candidates, frozen suites, validation receipts and immutable versions under `$DSH_HOME/harness/skill-owner`. This directory must not be a filesystem skill discovery root. The `harness-owner` provider exposes only committed versions and pins each loaded instruction body and resource directory to its digest. Existing global harness skills migrate only when their on-disk bundle matches the stored entry byte-for-byte and bears both harness author/source markers. Other files are untouched.

The provider uses rank 390: project and custom user roots retain their existing precedence, while managed versions supersede the default user-home filesystem copy (rank 400). A same-name skill in a higher-priority custom root can therefore shadow a managed version; publication does not override that user choice. Deployments using a custom root for legacy managed copies should check catalog precedence when migrating.

Production `/refine` and `harness_refine` submit a manual request to Evolution. They do not invoke a separate planner or write skills directly. Evolution must authorize the live ordinary Superagent Ticket, subject, asset scope and frozen candidate entry digest at stage, validation and publication. The owner rechecks publication authorization after validation. Neither a caller `passed` flag nor an LLM benchmark score authorizes publication.

## Provision independent execution cases

An administrator must provision `validation-suite.json` in the owner directory. No suite, an empty mandatory or holdout set, unavailable Docker daemon/image, or inconclusive results produce **blocked**. There is deliberately no generated default holdout suite: cases and answers must be independently authored for the deployment's skills and unavailable to the candidate author during planning.

```json
{
  "policyVersion": "deployment-policy-1",
  "image": "registry.example/skill-evaluator@sha256:<64 hexadecimal digest>",
  "platform": "linux",
  "timeoutMs": 30000,
  "mandatory": [{ "id": "script-execution", "command": ["/trusted/check-execution"] }],
  "holdout": [{ "id": "independent-fixture", "command": ["/trusted/check-holdout"] }]
}
```

The image must already be locally installed. Package trusted evaluators and frozen fixtures in that image; commands receive the candidate (or baseline) at `/skill`, a private writable `/output`, and private `/tmp`. Each command must print exactly one JSON object on stdout: `{"completed":true,"score":1}`. Scores must be finite in `[0,1]`. Mandatory cases require score 1; every holdout runs against both the exact baseline and candidate and permits no score regression. New skills use an empty baseline. Statistical A/B reports remain optional diagnostics and are not publication gates.

The default runner is Docker OCI only: a digest-pinned Linux image, read-only root and bundle mount, no network, no capabilities, non-root user, no inherited runtime credentials, bounded CPU/memory/PIDs/output/time, and private tmpfs output. There is no host-shell fallback. Windows-specific cases need a separately configured matching isolated runner; an unavailable matching environment must remain blocked. Administrators own suite/image provisioning and must prevent candidate authors from changing this trusted configuration. Host file access under the same unrestricted OS account is not a security boundary.

Receipts bind candidate, baseline, frozen suite, policy and environment digests and carry an owner-process HMAC. Receipts from a previous owner process must be revalidated after restart. Candidate bundles remain available for that revalidation. Publication commits its live pointer, publication receipt and idempotency lookup atomically; unknown-result callers query `/status` by idempotency key before retrying.

Internal authenticated component endpoints are POST `/candidates`, `/validate`, `/publish`, and `/status`. Owner publication receipts retain `skillId` and `publicationId` for the Evolution ledger. A rollback is another staged candidate targeting a prior immutable version's content and the current expected digest; it requires the same current authorization and validation as any update. Legacy direct deletion/rollback cannot bypass this gate.
