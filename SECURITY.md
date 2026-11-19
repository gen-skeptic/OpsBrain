# Security policy

OpsBrain is a private, self-hosted system of record. See [docs/opsbrain/05-security-and-privacy.md](docs/opsbrain/05-security-and-privacy.md) for the security model, privacy rules and operating practices.

## Reporting a vulnerability

Do not open a public issue. Report it privately to the repository owner through GitHub (a private security advisory on this repository), with:

- what the problem is and what it affects,
- steps to reproduce,
- any relevant files, versions or logs (with keys and personal data removed).

## In scope

- Authentication, key handling, delegation and role checks in `server/`
- Visibility and approval enforcement in `db/migrations/`
- The PARA exporter leaking restricted records or writing outside its folders
- Deployment defaults in `deploy/` that expose data or services
- Secrets committed to the repository

## If a key or record leaks

1. Revoke the key: `deno task admin key revoke <hash-prefix>`.
2. Disable the principal if needed: `deno task admin principal disable <handle>`.
3. Review `ops_record_events` and `ops_principal_keys.last_used_at` for the affected period.
4. Record what happened as an `incident` record (restricted if it involves personal data) and follow up with a `retrospective`.
