> **Org Status**: 🟢 Active
> **Cloudflare**: N/A
> **Last Audited**: 2026-04-28
---

# @apimom/client

TypeScript client SDK for [API Mom](https://github.com/garywu/api-mom) — unified egress for Cloudflare Workers.

## Install

```bash
npm install @apimom/client
```

## Usage

```typescript
import { createApiMom } from '@apimom/client';

const mom = createApiMom(env);
const child = mom.child('gemini', { function: 'generate' });
const result = await child.post('/gemini-2.0-flash:generateContent', { contents: [...] });
```

## Features

- Chainable `.child(service, context)` scoping (like Pino logger)
- Auto cost attribution via `X-Function` and `X-Tags` headers
- Service binding support (Worker-to-Worker, avoids CF error 1042)
- Budget checks and daily limit enforcement
- D1 instrumentation and Analytics Engine metrics

## Platform Utilities

```typescript
import { checkBudget, instrumentD1, writeMetric } from '@apimom/client/platform';
```

## License

MIT
