/**
 * @api-mom/client — API Mom Client SDK
 *
 * Automatic cost attribution for Cloudflare Workers.
 * Works like Pino child loggers: create a root client with project scope,
 * then create scoped children with function/tag context that auto-propagates.
 *
 * Usage:
 *   const mom = createApiMom(env)
 *   const gemini = mom.child('gemini', { function: 'article-write', brand: 'llc-tax' })
 *   const result = await gemini.post('/gemini-2.5-flash:generateContent', body)
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ApiMomEnv {
  API_MOM_URL?: string;
  API_MOM_KEY?: string;
  API_MOM_PROJECT?: string;
  /** Service binding (preferred over URL) */
  API_MOM?: Fetcher;
}

export interface ApiMomInterceptor {
  /** Return true to intercept this request */
  match: (service: string, endpoint: string, init: RequestInit) => boolean;
	/**
	 * Handle the intercepted request.
	 * Can return a mocked response, call a local CLI, or delegate back to the network.
	 */
	handle: (
		service: string,
		endpoint: string,
		init: RequestInit,
		next: (modifiedInit: RequestInit) => Promise<ApiMomResponse<any>>
	) => Promise<ApiMomResponse<any>>;
}

export interface ApiMomConfig {
  url: string;
  key: string;
  project: string;
  /** Service binding for Worker-to-Worker (avoids CF 1042) */
  binding?: Fetcher;
  /** Universal Registry for request interception (e.g., local CLI wrappers) */
  interceptors?: readonly ApiMomInterceptor[];
}

export interface ApiMomContext {
  /** Business function (article-write, anchor-gen, design-agent, etc.) */
  function?: string;
  /** Freeform tags for cost slicing */
  [key: string]: string | undefined;
}

export interface ApiMomResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  headers: Headers;
  cost?: string;
  cached?: string;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class ApiMomClient {
  private config: ApiMomConfig;
  private service: string | null;
  private context: ApiMomContext;

  constructor(config: ApiMomConfig, service?: string, context?: ApiMomContext) {
    this.config = {
      ...config,
      // Deep freeze the interceptors array to prevent runtime tampering (Command Injection vector)
      interceptors: config.interceptors ? Object.freeze([...config.interceptors]) : undefined
    };
    this.service = service ?? null;
    this.context = context ?? {};
  }

  /**
   * Create a scoped child client. Like pino.child() — inherits all parent
   * context and adds service + function/tag scope.
   *
   *   const gemini = mom.child('gemini', { function: 'article-write' })
   *   const linker = mom.child('gemini', { function: 'anchor-gen', brand: 'llc-tax' })
   */
  child(service: string, context?: ApiMomContext): ApiMomClient {
    return new ApiMomClient(this.config, service, {
      ...this.context,
      ...context,
    });
  }

  /**
   * GET request through API Mom proxy.
   *
   *   const result = await mom.child('youtube').get('/search', { q: 'cloudflare workers' })
   */
  async get<T = unknown>(
    endpoint: string,
    params?: Record<string, string>,
  ): Promise<ApiMomResponse<T>> {
    let url = this.buildUrl(endpoint);
    if (params) {
      const qs = new URLSearchParams(params).toString();
      url += (url.includes("?") ? "&" : "?") + qs;
    }
    return this.doFetch<T>(url, { method: "GET" });
  }

  /**
   * POST request through API Mom proxy.
   *
   *   const result = await gemini.post('/gemini-2.5-flash:generateContent', {
   *     contents: [{ parts: [{ text: 'Hello' }] }]
   *   })
   */
  async post<T = unknown>(
    endpoint: string,
    body?: unknown,
  ): Promise<ApiMomResponse<T>> {
    return this.doFetch<T>(this.buildUrl(endpoint), {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Call an internal API Mom route (e.g., /v1/costs, /v1/research).
   */
  async internal<T = unknown>(
    path: string,
    opts?: { method?: string; body?: unknown },
  ): Promise<ApiMomResponse<T>> {
    const url = this.config.binding
      ? `https://api-mom${path}`
      : `${this.config.url}${path}`;

    return this.doFetch<T>(url, {
      method: opts?.method ?? "GET",
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
  }

  /**
   * Get today's spend for this project.
   * Calls /v1/budget which is the authoritative spend endpoint.
   */
  async getTodaySpend(): Promise<{
    today_spend_usd: number;
    daily_limit_usd: number | null;
  }> {
    const res = await this.internal<{
      today_spend_usd: number;
      daily_limit_usd: number | null;
    }>("/v1/budget");
    return res.data;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private buildUrl(endpoint: string): string {
    if (!this.service)
      throw new Error(
        "ApiMomClient: no service set. Use .child(service) first.",
      );
    // Build proxy URL: /v1/{service}/{endpoint}
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    if (this.config.binding) {
      return `https://api-mom/v1/${this.service}${path}`;
    }
    return `${this.config.url}/v1/${this.service}${path}`;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "X-Project-ID": this.config.project,
      "X-API-Key": this.config.key,
      "Content-Type": "application/json",
    };

    // Auto-attach function context
    if (this.context.function) {
      headers["X-Function"] = this.context.function;
    }

    // Build tags from remaining context keys
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.context)) {
      if (k !== "function" && v !== undefined) {
        tags[k] = v;
      }
    }
    if (Object.keys(tags).length > 0) {
      headers["X-Tags"] = JSON.stringify(tags);
    }

    return headers;
  }

  private async doFetch<T>(
    url: string,
    init: RequestInit,
  ): Promise<ApiMomResponse<T>> {
    const executeNetworkFetch = async (modifiedInit: RequestInit): Promise<ApiMomResponse<T>> => {
      // 2. Build Network Request
      const headers = this.buildHeaders();

      // Convert Headers object to record if necessary to merge properly
      let overrideHeaders: Record<string, string> = {};
      if (modifiedInit.headers instanceof Headers) {
        modifiedInit.headers.forEach((v, k) => overrideHeaders[k] = v);
      } else {
        overrideHeaders = (modifiedInit.headers as Record<string, string>) ?? {};
      }

      const request = new Request(url, {
        ...modifiedInit,
        headers: {
          ...headers,
          ...overrideHeaders,
        },
      });

      const response = this.config.binding
        ? await this.config.binding.fetch(request)
        : await fetch(request);

      let data: T;
      try {
        data = (await response.json()) as T;
      } catch {
        data = {} as T;
      }

      // Check for daily_limit_exceeded
      if (response.status === 429) {
        const err = data as Record<string, unknown>;
        if (err?.error === "daily_limit_exceeded") {
          console.error("[api-mom] daily limit exceeded", {
            project: this.config.project,
            service: this.service,
            function: this.context.function,
            spend: err.spend,
            limit: err.limit,
          });
        }
      }

      return {
        ok: response.ok,
        status: response.status,
        data,
        headers: response.headers,
        cost: response.headers.get("X-APIMom-Cost") ?? undefined,
        cached: response.headers.get("X-APIMom-Cache") ?? undefined,
      };
    };

    // 1. Check Universal Registry (Interceptors)
    // We check the raw endpoint, derived by stripping the config URL/binding path
    // The service is known from this.service. The endpoint is derived for matching.
    const urlObj = new URL(url.startsWith("https://api-mom") ? url.replace("https://api-mom", "http://localhost") : url);
    const endpoint = urlObj.pathname.replace(`/v1/${this.service}`, "");

    if (this.service && this.config.interceptors) {
      const interceptor = this.config.interceptors.find((i) =>
        i.match(this.service as string, endpoint, init)
      );
      if (interceptor) {
        return interceptor.handle(this.service as string, endpoint, init, executeNetworkFetch) as Promise<ApiMomResponse<T>>;
      }
    }

    return executeNetworkFetch(init);
  }
}

// ─── Platform Observability (re-export) ─────────────────────────────────────

export type { BudgetCheckResult, BudgetConfig } from "./platform.js";
export { checkBudget, instrumentD1, writeMetric } from "./platform.js";

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an API Mom client from worker env.
 *
 * Reads from env:
 *   - API_MOM_URL (or API_MOM service binding)
 *   - API_MOM_KEY
 *   - API_MOM_PROJECT
 *
 *   const mom = createApiMom(env)
 *   const gemini = mom.child('gemini', { function: 'article-write' })
 */
export function createApiMom(env: ApiMomEnv, interceptors?: ApiMomInterceptor[]): ApiMomClient {
  const url =
    env.API_MOM_URL ?? "https://apimom-router.apiservices.workers.dev";
  const key = env.API_MOM_KEY;
  const project = env.API_MOM_PROJECT;

  if (!key) throw new Error("API_MOM_KEY not set — cannot create ApiMomClient");
  if (!project)
    throw new Error("API_MOM_PROJECT not set — cannot create ApiMomClient");

  return new ApiMomClient({ url, key, project, binding: env.API_MOM, interceptors });
}
