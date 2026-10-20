# Contributing

- Run the tests: `make test` (needs Node 18+ only).
- Zero-dependency rule: no npm packages, no build step beyond what is in the repo. Use Node built-ins.
- Keep changes small and add a test that fails before the change.
- Spec changes (`SPEC.md`, `schemas/`) need matching conformance fixtures, valid and invalid.
