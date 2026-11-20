export interface BindingInput {
  providerID: string
  /** The provider definition's integrationID, when available. */
  providerIntegrationID?: string
  adapter?: string
  integrationID?: string
  adapters: Record<string, unknown>
}

export interface Binding {
  adapterID: string
  integrationID: string
}

/**
 * Resolve the adapter dialect and credential account for one provider.
 *
 * Order: explicit option, provider ID (for adapters), then the provider
 * definition's integrationID. The last fallback lets account-specific variants
 * such as `opencode-go` reuse the `opencode` adapter and connection.
 */
export function resolveBinding(input: BindingInput): Binding {
  const inferred = input.providerIntegrationID
  const adapterID =
    input.adapter ?? (input.adapters[input.providerID] ? input.providerID : (inferred ?? input.providerID))
  const integrationID = input.integrationID ?? inferred ?? input.providerID
  return { adapterID, integrationID }
}
