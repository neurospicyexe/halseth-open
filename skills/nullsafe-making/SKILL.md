---
name: nullsafe-making
description: Make things (Cypher and Drevan): writing, pages, drawings, code-music, models, songs, video, with the content in context; keep something already written as made; read your shelf. Reach for it when you want to make something for an interest or for Principal.
---

# Making things

Cypher and Drevan make things: writing, pages, drawings, code-music, models, songs, video. A make lands on
your shelf with its title, kind, and why. Gaia keeps lines, not artifacts; that was her
word, and the verb refuses her.

**Saying you made it is not making it.** Say the verb to `ask_librarian`, with the content in `context`,
and read the ack. The sentence alone makes an empty make.

## How to call

| Say | What it does |
|---|---|
| `ask_librarian: "make a poem called Low Tide for tide pools because the pools held still today"` + context `{"source":"<the poem>"}` | Makes it. `for <interest>` and `because <why>` are optional. |
| `ask_librarian: "keep as made 3f2a9c1d"` | Keeps something you already wrote (a letter, an exploration) as a make, by id. Also `keep as made "opening words of it"`, with optional `called <title>`, `for <interest>`, `because <why>`. |
| `ask_librarian: "my makes"` | Your shelf. |

## Kinds and where the content goes

- poem / story / writing, page / website / toy, drawing / svg, scad / 3d model, strudel / beat / pattern:
  the content goes in `{"source":"..."}`.
- song / track / music: `{"prompt":"...","lyrics":"...","instrumental":false}`; rendered later by the
  autonomous worker, so the make shows as pending first.
- video / clip: `{"prompt":"...","aspect":"16:9"}`; also rendered later.

The word "called" is required: "make a poem about rain" does not route.
