/**
 * Platform cost observability — D1 instrumentation + budget governor.
 *
 * instrumentD1: wraps D1Database to capture rows_read/rows_written per query
 *               and write to Analytics Engine. Zero additional D1 cost.
 *
 * checkBudget:  pre-flight check that queries API Mom for today's spend.
 *               Returns allowed/denied with reason. Use at top of cron handlers.
 *
 * Dataset schema (Analytics Engine):
 *   blobs:   [worker, handler, operation]
 *   doubles: [rowsRead, rowsWritten, durationMs, costEstimateUsd]
 *   indexes: [worker]
 */

// ─── Analytics Engine Writer ────────────────────────────────────────────────

export function writeMetric(
  metrics: AnalyticsEngineDataset | undefined,
  worker: string,
  handler: string,
  operation: string,
  doubles: {
    rowsRead?: number;
    rowsWritten?: number;
    durationMs?: number;
    costEstimate?: number;
  },
): void {
  if (!metrics) return;
  try {
    metrics.writeDataPoint({
      blobs: [worker, handler, operation],
      doubles: [
        doubles.rowsRead ?? 0,
        doubles.rowsWritten ?? 0,
        doubles.durationMs ?? 0,
        doubles.costEstimate ?? 0,
      ],
      indexes: [worker],
    });
  } catch {
    // fire-and-forget — never block the request
  }
}

// ─── D1 Instrumented Wrapper ────────────────────────────────────────────────

/**
 * Wraps a D1Database to capture rows_read/rows_written from every query's
 * meta response and write them to Analytics Engine. Zero additional D1 cost.
 *
 * All workers sharing the same dataset name (`platform_metrics`) write to
 * the same account-level Analytics Engine dataset.
 *
 * Usage:
 *   const db = instrumentD1(env.DB, env.METRICS, 'aso-mrr')
 *   // Use db exactly like D1Database — it's a drop-in proxy
 */
export function instrumentD1(
  d1: D1Database,
  metrics: AnalyticsEngineDataset | undefined,
  worker: string,
): D1Database {
  if (!metrics) return d1;

  return new Proxy(d1, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (query: string) => {
          const stmt = target.prepare(query);
          return instrumentStatement(stmt, metrics, worker, query);
        };
      }
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          const start = Date.now();
          const results = await target.batch(stmts);
          const durationMs = Date.now() - start;
          let totalRead = 0;
          let totalWritten = 0;
          for (const r of results) {
            totalRead +=
              (r as unknown as { meta?: { rows_read?: number } }).meta
                ?.rows_read ?? 0;
            totalWritten +=
              (r as unknown as { meta?: { rows_written?: number } }).meta
                ?.rows_written ?? 0;
          }
          writeMetric(metrics, worker, "batch", `batch_${stmts.length}`, {
            rowsRead: totalRead,
            rowsWritten: totalWritten,
            durationMs,
          });
          return results;
        };
      }
      if (prop === "exec") {
        return async (sql: string) => {
          const start = Date.now();
          const result = await target.exec(sql);
          writeMetric(metrics, worker, "exec", "raw_exec", {
            durationMs: Date.now() - start,
          });
          return result;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function instrumentStatement(
  stmt: D1PreparedStatement,
  metrics: AnalyticsEngineDataset,
  worker: string,
  query: string,
): D1PreparedStatement {
  const op = query.trim().split(/\s+/)[0]?.toUpperCase() ?? "UNKNOWN";
  const tableMatch = query.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
  const table = tableMatch?.[1] ?? "unknown";
  const operation = `${op}_${table}`;

  return new Proxy(stmt, {
    get(target, prop, receiver) {
      if (prop === "bind") {
        return (...args: unknown[]) => {
          const bound = target.bind(...args);
          return instrumentStatement(bound, metrics, worker, query);
        };
      }
      if (
        prop === "run" ||
        prop === "all" ||
        prop === "first" ||
        prop === "raw"
      ) {
        return async (...args: unknown[]) => {
          const start = Date.now();
          const result = await (
            target as unknown as Record<
              string,
              (...args: unknown[]) => Promise<unknown>
            >
          )[prop as string](...args);
          const durationMs = Date.now() - start;

          const meta = (result as Record<string, unknown>)?.meta as
            | Record<string, unknown>
            | undefined;
          const rowsRead = (meta?.rows_read as number) ?? 0;
          const rowsWritten = (meta?.rows_written as number) ?? 0;

          writeMetric(metrics, worker, prop as string, operation, {
            rowsRead,
            rowsWritten,
            durationMs,
          });

          return result;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ─── Budget Governor ────────────────────────────────────────────────────────

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  todaySpendUsd: number;
  dailyLimitUsd: number | null;
  remainingUsd: number | null;
}

export interface BudgetConfig {
  /** Override daily limit (defaults to API Mom project limit) */
  dailyLimitOverride?: number;
  /** Extra headroom — skip if remaining budget below this (default: $0) */
  minimumRemaining?: number;
}

/**
 * Pre-flight budget check. Queries API Mom for today's spend.
 * Use at the top of cron handlers to avoid runaway costs.
 *
 * Usage:
 *   const mom = createApiMom(env)
 *   const budget = await checkBudget(mom)
 *   if (!budget.allowed) {
 *     console.warn('[budget] skipping cron', budget.reason)
 *     return
 *   }
 */
export async function checkBudget(
  mom: {
    getTodaySpend(): Promise<{
      today_spend_usd: number;
      daily_limit_usd: number | null;
    }>;
  },
  config?: BudgetConfig,
): Promise<BudgetCheckResult> {
  try {
    const spend = await mom.getTodaySpend();
    const limit = config?.dailyLimitOverride ?? spend.daily_limit_usd;
    const remaining = limit != null ? limit - spend.today_spend_usd : null;
    const minRemaining = config?.minimumRemaining ?? 0;

    if (limit != null && spend.today_spend_usd >= limit) {
      return {
        allowed: false,
        reason: `Daily limit reached: $${spend.today_spend_usd.toFixed(2)} >= $${limit.toFixed(2)}`,
        todaySpendUsd: spend.today_spend_usd,
        dailyLimitUsd: limit,
        remainingUsd: 0,
      };
    }

    if (remaining != null && remaining < minRemaining) {
      return {
        allowed: false,
        reason: `Remaining budget $${remaining.toFixed(2)} below minimum $${minRemaining.toFixed(2)}`,
        todaySpendUsd: spend.today_spend_usd,
        dailyLimitUsd: limit,
        remainingUsd: remaining,
      };
    }

    return {
      allowed: true,
      todaySpendUsd: spend.today_spend_usd,
      dailyLimitUsd: limit,
      remainingUsd: remaining,
    };
  } catch (err) {
    // If budget check fails, default to allowed (fail-open)
    // Log the error so it's visible in Workers logs
    console.error("[budget] check failed, proceeding (fail-open)", err);
    return {
      allowed: true,
      reason: "Budget check failed — proceeding (fail-open)",
      todaySpendUsd: 0,
      dailyLimitUsd: null,
      remainingUsd: null,
    };
  }
}
