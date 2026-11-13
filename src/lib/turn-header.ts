// Turn key phase 2 (BBH Hand-off/SPEC-turn-key-2026-11-11.md). The Discord bots mint one id per RUN
// (`<companion>-<YYYYMMDDTHHMMSS>-<4 base36>`) and send it as X-Turn-Id on every Halseth request made
// inside that run. This Worker logs it: one `turn_request` line per such request (Workers Logs groups
// every other line of the same invocation with it), and the Librarian logger binds it as `turn`.
//
// IDS ONLY: method, path (no query string), status, ms. Never a body. The header is validated so a
// malformed value can never inject into a log line; anything else is ignored, never rejected.
// No schema change: journal rows carry the id as a `turn:<id>` TAG, written by the bot.

export const TURN_HEADER = "X-Turn-Id";
const TURN_ID_RE = /^[a-z][a-z0-9_]{1,23}-\d{8}T\d{6}-[0-9a-z]{4}$/;

/** The validated turn id on this request, else null. */
export function turnIdFrom(request: Request): string | null {
  const v = request.headers.get(TURN_HEADER);
  if (!v) return null;
  const t = v.trim();
  return TURN_ID_RE.test(t) ? t : null;
}

export interface TurnRequestLine {
  event: "turn_request";
  turn: string;
  method: string;
  path: string;
  status: number;
  ms: number;
}

export function turnRequestLine(turn: string, request: Request, status: number, ms: number): TurnRequestLine {
  let path = "";
  try { path = new URL(request.url).pathname.slice(0, 200); } catch { path = ""; }
  return { event: "turn_request", turn, method: request.method, path, status, ms: Math.max(0, Math.round(ms)) };
}

/** Never throws: a log line is never the reason a request fails. */
export function logTurnRequest(turn: string, request: Request, status: number, ms: number, sink: (s: string) => void = console.log): void {
  try { sink(JSON.stringify(turnRequestLine(turn, request, status, ms))); } catch { /* fail-open */ }
}
