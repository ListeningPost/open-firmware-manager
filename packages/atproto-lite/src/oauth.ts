/**
 * ATProto OAuth 2.1 is the 2026 path for interactive apps.
 * Headless publishers / CI keep com.atproto.server.createSession + app passwords.
 *
 * Request scopes (granular): atproto, include:app.openfirmware.authPublisher, and blob wildcard.
 * This module only emits client metadata. Wire @atproto/oauth-client-node in
 * a public-origin web app; do not embed a confidential client secret in ofw.
 */

export interface OAuthClientMetadata {
  client_id: string
  client_name: string
  client_uri: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  scope: string
  token_endpoint_auth_method: 'none' | 'private_key_jwt'
  dpop_bound_access_tokens: true
  application_type: 'web'
}

export function publisherClientMetadata(origin: string): OAuthClientMetadata {
  const base = origin.replace(/\/$/, '')
  return {
    client_id: `${base}/oauth-client-metadata.json`,
    client_name: 'Open Firmware',
    client_uri: base,
    redirect_uris: [`${base}/oauth/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'atproto include:app.openfirmware.authPublisher blob:*/*',
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
    application_type: 'web',
  }
}
