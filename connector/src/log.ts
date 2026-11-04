/**
 * Structured JSON logger. Never pass tokens, secrets, or record bodies here;
 * log identifiers and outcomes only.
 */
export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

export const jsonLogger: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
};

export const silentLogger: Logger = () => {};
