/**
 * Outbound WhatsApp delivery.
 *
 * The provider receives an already-rendered message. It does not see the call,
 * the transcript, or the model — rendering happens in `@towai/shared` from a
 * persisted lead, so there is no path from model output to an operator's phone.
 */

export interface WhatsAppMessage {
  /** E.164 destination, without the `whatsapp:` scheme prefix. */
  to: string;
  /** The rendered plain-text body. */
  body: string;
  /**
   * Ordered variables for an approved template, when one is configured.
   * WhatsApp requires a template for business-initiated messages outside the
   * 24-hour service window, and a lead notification is always business-initiated.
   */
  templateVariables?: Record<string, string>;
}

export interface WhatsAppSendResult {
  providerMessageId: string;
}

/**
 * Thrown for failures worth retrying (timeouts, 5xx, rate limits) as opposed to
 * permanent ones (a malformed number), so the queue can stop hammering a
 * request that will never succeed.
 */
export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WhatsAppSendError';
  }
}

export interface WhatsAppProvider {
  readonly name: string;
  send(message: WhatsAppMessage): Promise<WhatsAppSendResult>;
}

export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
