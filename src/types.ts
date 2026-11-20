/** true = invocable, false = refused, undefined = inconclusive. */
export type Verdict = true | false | undefined

/** Provider metadata, normalized by each adapter into one shape. */
export interface NormalizedEntry {
  id: string
  name?: string
  family?: string
  created?: number
  contextWindow?: number
  outputLimit?: number
  vision?: boolean
  tools?: boolean
  raw: unknown
}

/**
 * Everything that differs between providers lives behind this interface:
 * metadata field names, which models are worth probing, and what an HTTP
 * status means. The reconciliation engine never sees provider specifics.
 *
 * Adapters have no identity of their own. The registry key in `index.ts` is
 * the adapter ID, and it is also the provider ID used for inference.
 */
export interface Adapter {
  normalize(entry: any): NormalizedEntry
  /** Restrict which live entries get probed (e.g. a free tier only). */
  select?(entries: any[], offered: Set<string>): any[]
  /** Map an HTTP status from the probe to a verdict. */
  classify(status: number): Verdict
}

export interface ProviderConfig {
  adapterID: string
  providerID: string
  integrationID: string
  baseURL: string
  /** Provider-defined headers such as org or billing metadata. */
  headers?: Record<string, string>
  userAgent?: string
  reasoningField: string
  refreshMinutes: number
  probeConcurrency: number
  storageKey: string
  statusPath: string
}
