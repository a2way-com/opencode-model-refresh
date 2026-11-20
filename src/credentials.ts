/** A credential resolved by OpenCode's connection store or provider settings. */
export interface ResolvedCredential {
  token: string
  /** OAuth access tokens can expire; 401 is not proof that a model is gone. */
  oauth: boolean
}

/**
 * Read a credential returned by OpenCode. `connection.resolve` returns a typed
 * Credential.Value (key or OAuth grant); legacy shapes are handled as a
 * fallback without guessing OAuth tokens from arbitrary fields.
 */
export function credentialOf(credential: any): ResolvedCredential | undefined {
  if (!credential) return undefined
  if (typeof credential === "string") return { token: credential, oauth: false }
  if (typeof credential !== "object") return undefined
  if (credential.type === "key") {
    return typeof credential.key === "string" ? { token: credential.key, oauth: false } : undefined
  }
  if (credential.type === "oauth") {
    return typeof credential.access === "string"
      ? { token: credential.access, oauth: true }
      : undefined
  }
  for (const field of ["apiKey", "token", "value", "secret"]) {
    if (typeof credential[field] === "string" && credential[field]) {
      return { token: credential[field], oauth: false }
    }
  }
  return undefined
}
