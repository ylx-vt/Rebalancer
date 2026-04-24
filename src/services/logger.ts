const PREFIX = "[Rebalancer]";

export const logDebug = (scope: string, message: string, data?: unknown) => {
  console.debug(`${PREFIX} ${scope} ${message}`, data ?? "");
};

export const logInfo = (scope: string, message: string, data?: unknown) => {
  console.info(`${PREFIX} ${scope} ${message}`, data ?? "");
};

export const logWarn = (scope: string, message: string, data?: unknown) => {
  console.warn(`${PREFIX} ${scope} ${message}`, data ?? "");
};

export const logError = (scope: string, message: string, data?: unknown) => {
  console.error(`${PREFIX} ${scope} ${message}`, data ?? "");
};
