/** Public provider identity. */
export const PROVIDER_ID = 'zen-free'

/** OpenCode Zen API endpoint. */
export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

/** Pi's protocol catalog for the OpenCode provider. */
export const PI_CATALOG_URL = 'https://pi.dev/api/models/providers/opencode'

/** OpenCode's deployed model catalog. */
export const ZEN_MODELS_URL = `${ZEN_BASE_URL}/models`

/** Public capability and pricing catalog. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

export const ZEN_KEY_VAR = 'PI_ZEN_FREE_KEY'
export const OPENCODE_KEY_VAR = 'OPENCODE_API_KEY'
export const FETCH_TIMEOUT_MS = 15000
export const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000
