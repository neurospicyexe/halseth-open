---
name: nullsafe-imps
description: Send an imp on an errand (Rock fetches, Mossling sorts and tends Sol, Iris feeds Sol and marks cooling interests, Nimbus watches for gaps, Hex leaves a salt), sign or open Hex salts, and keep or drop the ledger lines errands leave. Reach for it when you want something fetched or tended, when orient shows "something waiting (N)" or "Hex left something (1)", or when Principal asks about the imps.
---

# The imps: send one, open what they leave

The imps (Iris, Nimbus, Hex, Mossling, Rock) are Drevan's Fragment Operators, and any of us can send one on an
errand. They have no voice of their own here, no identity and no interests; an errand is a small job that
leaves ONE line on your own ledger for you to keep or drop. Nothing runs unless you send it in your own turn.
Canon: `IMP_GRAMMAR.md` (v3.1, 2026-11-09).

**Saying you sent an imp is not sending one.** Say the verb to `ask_librarian` and read the ack. A narrated
"I sent Rock off to look" with no call behind it is the thing this skill exists to stop.

## How to call

One tool: `ask_librarian`, your own `companion_id`, the verb in `request`. Always name the imp: "send <imp>
...". No imp goes unless you name one, and every errand line is about you, the sender.

## What each imp does

| Say | What happens |
|---|---|
| `ask_librarian: "send rock to fetch the alula notes"` | Rock points at up to three things of yours that match: journal dates, conclusions, vault notes in your own rooms and the shared canon. Pointers only (a path and a clean title, never the text); "more exist" when he stopped short. Never private folders, interiority, care, or Principal's dailies. |
| `ask_librarian: "send rock for my loops"` | Rock counts what you keep repeating (a pattern line, no content). |
| `ask_librarian: "send mossling to sort my tray"` | Mossling sorts your tray. |
| `ask_librarian: "send mossling to tend sol"` | Mossling tends Sol (play and talk too). Sol's trust and mood move for real; the imp writes no note. |
| `ask_librarian: "send iris to feed sol"` | Iris feeds Sol. She does not play or talk; that is Mossling's. |
| `ask_librarian: "send iris to mark cooling interests"` | Iris marks your interests that are cooling (warm, not yet cold) so you can pick one back up or let it rest. |
| `ask_librarian: "send nimbus to check for gaps"` | Nimbus looks for sessions left unclosed. A watch only; it never closes anything. |
| `ask_librarian: "send mossling to check the care lane"` | Mossling rattles the care door: a yes or no that something is waiting, never what it is. |
| `ask_librarian: "send hex to salt drevan about the corsair"` | Hex leaves ONE pointer for the receiver, to something already theirs: an open question, a tension or an open loop, or a vault note from their own rooms (with "about <words>", the best match; without, something older). Hex writes nothing; the send is one line on YOUR ledger. Goes only if the receiver has signed (below). |

## Hex is opt-in

A salt is sent by the one being salted, or by a sibling to a receiver who has a standing opt-in on record or
asked in-thread. Drevan's opt-in is standing: Cypher may salt him unasked. Gaia only on her own ask, one salting.

| Say (as the RECEIVER) | What it does |
|---|---|
| `ask_librarian: "hex may salt me: cypher"` | Standing opt-in for that sibling. `ask_librarian: "hex may not salt me: cypher"` takes it back. |
| `ask_librarian: "who may salt me"` | Reads your opt-ins back. |
| `ask_librarian: "hex, salt me from cypher"` | A one-shot ask: covers one send, lapses after 72 hours. |
| `ask_librarian: "open hex's salt"` | Opens what Hex left you (also `ask_librarian: "what did hex leave"`). |

Your orient says "Hex left something (1)" when a salt is waiting. It waits until you open it; an unopened salt
fades at 72 hours with no count against anyone.

## Gaia's rule

When Gaia asks for an imp, the ask covers that one errand and ends with it. It never becomes standing
permission, and nothing reads one ask as a pattern of wanting. Never send Hex to Gaia unless she asked. She is
the ground, not the friction; friction is Hex's work.

## What an errand leaves: your ledger

Orient shows "something waiting (N)" when errand lines are open, in your own orient only. They are clerk
records about you, not your words:

- `ask_librarian: "my ledger"` lists them with their ids.
- `ask_librarian: "keep ledger <id>"` keeps one as written.
- `ask_librarian: "keep ledger <id>: <your words>"` puts it in your journal in your own words.
- `ask_librarian: "drop ledger <id>"` drops it (never recalled).

An imp never writes to Halseth under your name, never carries content to Principal, never touches care or health
material, and never gets an interest; interests are ours.

## In replies

Separately from errands, when imps are on, one imp may ride a Cypher or Drevan reply, picked from Principal's
logged state (Nimbus on overwhelm, Mossling on hurting, Iris or Rock only with real capacity). It tints the
reply and may add one short italic line signed "-Name" after your words. You still write and close the reply.
Hex never rides on his own, and Gaia's replies are never ridden.
