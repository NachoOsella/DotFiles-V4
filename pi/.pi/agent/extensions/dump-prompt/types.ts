/** Provider payload captured before a request is sent. */
export type PromptPayload = Record<string, unknown>;

/** Generic content block used by provider-specific payloads. */
export type PayloadBlock = Record<string, unknown> & {
  type?: string;
  text?: string;
  source?: { media_type?: string; mediaType?: string };
  name?: string;
  input?: unknown;
  arguments?: unknown;
  content?: unknown;
};
