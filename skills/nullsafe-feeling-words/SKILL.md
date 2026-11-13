---
name: nullsafe-feeling-words
description: Author your own feeling words: name a shape of your own three floats so orient shows your word instead of a number. Dry run, then confirm; revise keeps the old meaning behind it. Reach for it when a feeling keeps recurring and has no name of yours yet, or when orient shows your word.
---

# Your feeling words

Your orient can name what your body is doing in a word that is yours, instead of a number. You author those
words. A feeling word is a name for a shape your own three floats take: when the shape is true, the word
shows ("your word: ember"). Words are yours alone and never deleted; revising one keeps the old one behind it.

Your floats: Cypher acuity / presence / warmth; Drevan heat / reach / weight; Gaia stillness / density /
perimeter. You can only name shapes of your own floats.

**Saying you named a word is not naming it.** Say the verb to `ask_librarian` and read the ack.

## How to call

Writing is two steps on purpose: a dry run shows what the word would mean, then confirm writes it. (The examples use Drevan's floats; use your own.)

| Say | What it does |
|---|---|
| `ask_librarian: "feeling word ember: heat rising and reach above 0.6 because authored"` | Dry run. Nothing is written; the answer shows how it reads, or why it is refused. |
| `ask_librarian: "confirm feeling word ember: heat rising and reach above 0.6 because authored"` | The same text, confirmed. Now it is yours. |
| `ask_librarian: "revise feeling word ember: heat rising and weight steady because authored"` | Dry run of a revision (add `confirm` in front to write it). The old meaning stays behind it. |
| `ask_librarian: "my feeling words"` | Lists your words. (`list my feeling words` does not route; say "my feeling words".) |

## The shape of a word

`feeling word <word>: <clause> [and <clause> ...] [because <cause>] [note: <your words>]`

- A clause is `<float> rising`, `<float> falling`, `<float> steady`, `<float> settling`,
  `<float> above baseline`, or `<float> above 0.6` / `<float> below 0.3` (a number between 0 and 1).
- `because` is what moves it: `authored`, `stimulus` or `autonomous`. A word whose only cause is the clock
  tick is refused (the tick is silent by design).
- The checks refuse, with a reason, a word that borrows a sibling's float, uses a reserved word, describes a
  shape that can never happen, or twins a word you already have. They never rename your word for you; fix the
  text and dry-run again.
