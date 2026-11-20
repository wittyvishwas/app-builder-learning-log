/*
 * Ep 9: second gate for the Admin UI SDK actions, on top of `require-adobe-auth: true`.
 * v1 has no per-action permissions, and any valid Adobe token of the org passes require-adobe-auth. So the action also
 * checks the token's `client_id` (the app that asked for the token) against the ALLOWED_CLIENT_IDS input
 * (comma-separated, from .env). Call it first in each action:
 *   const denied = checkClient(params); if (denied) return denied
 * Answers: 401 token missing or unreadable, 500 allowlist empty (fails closed: nothing is allowed), 403 other client.
 * The token's signature is NOT verified here: require-adobe-auth already validated the token before the action ran.
 * This only reads the claim. Never log the token.
 */
const reply = (statusCode, error) => ({ statusCode, body: { error } })

// The `client_id` claim of the bearer token in the request headers, or null when there is no readable one.
function clientIdOf (params) {
  const header = (params.__ow_headers || {}).authorization
  const match = typeof header === 'string' && /^Bearer\s+(\S+)$/i.exec(header)
  const parts = match && match[1].split('.')
  if (!parts || parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return claims && typeof claims.client_id === 'string' && claims.client_id ? claims.client_id : null
  } catch (e) {
    return null
  }
}

// null when the caller's client is allowed, otherwise the response to return.
function checkClient (params) {
  const clientId = clientIdOf(params)
  if (!clientId) return reply(401, 'unauthorized')
  const allowed = String(params.ALLOWED_CLIENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!allowed.length) return reply(500, 'ALLOWED_CLIENT_IDS is not set')
  return allowed.includes(clientId) ? null : reply(403, 'forbidden')
}

module.exports = { checkClient, clientIdOf }
