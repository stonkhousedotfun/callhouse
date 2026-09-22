export type PushGuidance = "supported" | "ios-install" | "mobile-unsupported" | "unsupported";

export type PushRuntime = {
  userAgent: string;
  maxTouchPoints: number;
  userAgentDataMobile?: boolean;
  standalone: boolean;
  displayModeStandalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
};

function isIos(runtime: PushRuntime): boolean {
  return /iPad|iPhone|iPod/u.test(runtime.userAgent)
    || (/Macintosh/u.test(runtime.userAgent) && runtime.maxTouchPoints > 1);
}

function isMobile(runtime: PushRuntime): boolean {
  return runtime.userAgentDataMobile === true
    || /Android|Mobile|iPad|iPhone|iPod/u.test(runtime.userAgent)
    || (/Macintosh/u.test(runtime.userAgent) && runtime.maxTouchPoints > 1);
}

export function pushGuidance(runtime: PushRuntime): PushGuidance {
  const standalone = runtime.standalone || runtime.displayModeStandalone;
  if (isIos(runtime) && !standalone) return "ios-install";

  const supported = runtime.hasServiceWorker && runtime.hasPushManager && runtime.hasNotification;
  if (supported) return "supported";
  return isMobile(runtime) ? "mobile-unsupported" : "unsupported";
}

export function applicationServerKeyMatches(
  subscription: Pick<PushSubscription, "options">,
  currentKey: Uint8Array<ArrayBuffer>,
): boolean {
  const subscribedKey = subscription.options.applicationServerKey;
  if (!subscribedKey || subscribedKey.byteLength !== currentKey.byteLength) return false;

  const subscribedBytes = new Uint8Array(subscribedKey);
  return subscribedBytes.every((byte, index) => byte === currentKey[index]);
}

export async function ensurePushSubscription(
  manager: Pick<PushManager, "getSubscription" | "subscribe">,
  currentKey: Uint8Array<ArrayBuffer>,
): Promise<PushSubscription> {
  const existing = await manager.getSubscription();
  if (existing && applicationServerKeyMatches(existing, currentKey)) return existing;

  if (existing) {
    const removed = await existing.unsubscribe();
    if (!removed) throw new Error("The browser could not replace its old push key. Remove this site's notification permission and try again.");
  }

  return manager.subscribe({ userVisibleOnly: true, applicationServerKey: currentKey });
}
