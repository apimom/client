> **Org Status**: 🟢 Active
> **Cloudflare**: N/A
> **Last Audited**: 2026-05-09
---

# @apimom/client

TypeScript client SDK for [API Mom](https://github.com/garywu/api-mom) — unified egress for Cloudflare Workers.

## Install

```bash
npm install @apimom/client
```

## Architecture

This SDK is the canonical fleet client for LLM inference, implementing the **Unified Inference Substrate** doctrine.
For full context, see:
- Substrate Audit: `_readme/architecture/audit-platform-substrate-2026-05-09.md`
- Strategic Moves Brief: `_readme/architecture/strategic-moves-brief-2026-05-09.md`

## The Interceptor Pattern

Every alternative dispatch method (Cloud AI Gateway, direct fallback, local CLI, local WASM, local GGUF) is implemented as an interceptor. The interceptor pattern allows you to mock, substitute, or bypass network calls seamlessly based on the `service` and `endpoint`.

The canonical example is the local Gemini CLI interceptor, which intercepts calls meant for Gemini and routes them to a local subprocess:

```typescript
import { createApiMom } from "@apimom/client";
import { execFile } from "node:child_process";

const mom = createApiMom(env, [
  async (req, next) => {
    // Intercept Gemini calls in local dev
    if (req.service === "gemini" && process.env.NODE_ENV === "development") {
      // route to local subprocess...
      return { ok: true, data: { ... }, cost: "0.00 (Local)", headers: new Headers() };
    }
    // Fall through to real network
    return next(req);
  }
]);
```

## Uniform Contract

All calls share a uniform request and response shape, regardless of whether they hit the network or a local interceptor:
- **Request**: `{ service, endpoint, payload, init }`
- **Response**: `{ ok, data, cost, headers }`

**Cost Convention**: For local/free interceptors, the `cost` field must return exactly `"0.00 (Local)"` to maintain a uniform cost ledger while preserving reality.

## Usage

```typescript
import { createApiMom } from '@apimom/client';

const mom = createApiMom(env);
const child = mom.child('gemini', { function: 'generate' });
const result = await child.post('/gemini-2.0-flash:generateContent', { contents: [...] });
```

## Platform Utilities

```typescript
import { checkBudget, instrumentD1, writeMetric } from '@apimom/client/platform';
```

## License

MIT
