import type { ServerNotification } from '../generated/ServerNotification';

/** A JSON-RPC notification as it comes off the wire, before it is typed. */
export interface RawNotification {
  method: string;
  params?: unknown;
}

/**
 * The single point where untyped wire data becomes a typed `ServerNotification`.
 *
 * `ServerNotification` is generated from the Rust definitions by ts-rs and is a union
 * discriminated on `method`, so narrowing on `method` gives correctly typed `params`.
 * Everything downstream must go through here rather than reading fields off `any`.
 */
export function asServerNotification(raw: RawNotification): ServerNotification {
  return raw as unknown as ServerNotification;
}

/** Notification methods this extension acts on. Anything else is ignored. */
const HANDLED_METHODS = new Set<ServerNotification['method']>([
  'error',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'thread/started',
  'thread/status/changed',
  'thread/closed',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/completed',
]);

export function isHandled(notification: ServerNotification): boolean {
  return HANDLED_METHODS.has(notification.method);
}
