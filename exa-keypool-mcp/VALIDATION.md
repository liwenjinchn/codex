# Validation record

Date: 2026-10-28

- `npm test`: 35 tests passed, 0 failures.
- `npm audit --omit=dev`: 0 vulnerabilities after pinning Zod 4.6.7.
- Runtime used: Node 24.22.1, npm 11.9.0.
- `npm run check`: all four source modules passed Node syntax checks.
- Actual MCP stdio subprocess initialized and answered tools/list and exa_pool_status using the official SDK client.
- Search and Contents provider calls are mocked. No real Exa API key was supplied or used.
- No live Claude Code installation was available for end-to-end client testing.

See README for a local smoke test using your own keys. Tests do not read your key file and do not make paid requests.

Version 0.1.1 robustness review added 16 tests, including native fetch over loopback sockets, MCP cancellation, EOF and oversized stdio input, and 300 bounded concurrent mock requests. Eight regression tests failed on 0.1.0 before the fixes. See ROBUSTNESS_REVIEW.md for evidence and limitations.
