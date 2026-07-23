# Contributing

1. Use Node.js 22 or 24 (the versions CI runs; the package requires >= 22.14).
2. Run `npm ci`.
3. Create focused changes with tests.
4. Run `npm run verify` before opening a pull request.
5. Never weaken path containment, command policy, environment filtering, or isolated-workspace behavior without a documented threat-model update.

All contributions are licensed under Apache-2.0.
