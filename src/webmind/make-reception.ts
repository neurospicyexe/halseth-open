// src/webmind/make-reception.ts -- reception signals for a make, written into the EXISTING heard_back column.
//
// heard_back was the companion's own line and nothing else ever wrote it (29 of 29 null on 11-11). Surfaces now
// report what they OBSERVE: Hearth opening a make ("seen"), Principal answering the DM where a make was shown
// ("replied"). A signal is a tagged line and only ever fills an EMPTY heard_back, except that "replied" may
// upgrade a "[seen]" (it is the stronger signal). The companion's own PATCH always overwrites anything.
// No new column (another agent owns migration 0179).

export const RECEPTION_SEEN_TAG = "[seen]";
export const RECEPTION_REPLIED_TAG = "[replied]";
export type ReceptionSignal = "seen" | "replied";

export const VALID_VIA = new Set(["hearth", "discord"]);

/** The line to store, or null when nothing should change. `existing` is the current heard_back. */
export function receptionLine(
  signal: ReceptionSignal, via: string, existing: string | null, now: Date = new Date(),
): string | null {
  const day = now.toISOString().slice(0, 10);
  const cur = (existing ?? "").trim();
  if (signal === "seen") {
    if (cur) return null;
    return `${RECEPTION_SEEN_TAG} Principal opened it on ${via} ${day}`;
  }
  // replied
  if (cur && !cur.startsWith(RECEPTION_SEEN_TAG)) return null; // the companion's own line, or already replied
  return `${RECEPTION_REPLIED_TAG} Principal answered it on ${via} ${day}`;
}
