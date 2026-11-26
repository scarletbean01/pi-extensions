# 02: Replies go to the prompt the turn answered, oldest first

**What to build:** When several Coms prompts reach one agent close together, for example at a join, each reply goes back to that prompt's own sender. Today the agent tracks whichever prompt arrived last on the socket and answers the newest unanswered prompt first, while Pi processes queued follow-ups oldest first (its default one-at-a-time queue). After this ticket:

- Arrival only adds a prompt to the pending set.
- The prompt a turn is answering is identified from that turn's `coms-inbound` message (the message ID in its details).
- A `coms_send` made during the turn inherits that prompt's hop count.
- End-of-turn reply dispatch fulfils the oldest unfulfilled prompt.
- A prompt arriving mid-turn cannot change the current turn's routing or hop count.

Spec: `../spec.md` (Coms implementation decisions; user stories 6–10).

**Blocked by:** None (can start immediately)

**Status:** done

- [x] A real-process runtime test sends two prompts from two different senders while the receiver's turn is in progress. Each sender receives the reply to its own prompt, oldest first.
- [x] A `coms_send` issued during a turn carries the hop count of the prompt that turn answers, even if a later prompt arrived mid-turn.
- [x] A single prompt with no concurrency behaves exactly as before. Existing Coms and bootstrap suites pass.
