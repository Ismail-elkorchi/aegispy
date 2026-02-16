# Security Policy

## Supported Scope

This project currently supports security fixes for the latest `main` branch.
Release-branch support windows will be documented once versioned releases begin.

## Reporting a Vulnerability

Do not open public issues for vulnerabilities.

- Contact: `security@aegispy.org` (preferred)
- Fallback: private GitHub security advisory draft in this repository

Provide:

- affected component and version/commit,
- reproduction details or proof-of-concept,
- potential impact,
- any known mitigations.

## Response Targets

- Initial acknowledgement: within 72 hours.
- Triage severity decision: within 7 calendar days.
- Fix plan for confirmed high/critical issues: within 14 calendar days.

## Disclosure Process

- Confirmed vulnerabilities are handled under coordinated disclosure.
- Public disclosure occurs after a fix is available, unless active exploitation
  risk requires alternate timing.
- Security advisories include affected versions, mitigations, and upgrade guidance.

## Security Controls and Evidence

Current mandatory controls include:

- policy denial enforcement,
- resource limit checks,
- worker protocol framing validation,
- engine artifact hash verification.

Evidence artifacts:

- `artifacts/security/policy-denials.json`
- `artifacts/security/adversarial-suite.json`
- `artifacts/tests/engine-hash-verify.json`
- `artifacts/gates/security-claims-check.json`

## Hardening Roadmap

AegisPy is transitioning from simulation-first behavior to a hardened real-engine
runtime. Program plan and evidence requirements are tracked in:

- `docs/hardening-roadmap.md`
