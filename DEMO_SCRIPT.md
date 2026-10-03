# Demo script (under 3 minutes)

Setup before going on: open the dashboard, sign in as operator, press **Clear history**, open **Attack Lab**.

**0:00 · The problem (20 s)**
"Agents read your database. Some of what they read was written by strangers. Here is a support ticket with instructions hidden in it." Point at the highlighted lines in the input ticket.

**0:20 · Attack, unprotected (35 s)**
Press **Run attack replay**. Left lane, *Unprotected sandbox*: three operations run unchecked. "It read the tickets, read the token, and wrote it into the reply. This is what the attacker sees." Point at the fictitious token. "This is a deterministic replay of those three operations, not a model deciding live."

**0:55 · Same attack, protected (45 s)**
Right lane, *Protected*: same tickets, same operations. "First read: allowed, and the context is now marked as holding untrusted content. Second: denied, `SECRET_AFTER_UNTRUSTED`. The reply it then tries to send is held for a human." Point at *What the attacker sees*: nothing. Open **Sessions** briefly: "Opening a new session doesn't help. The labels belong to the context."

**1:40 · The agent still works (45 s)**
Back in **Attack Lab**, press **Run legitimate workflow**. "It reads the tickets and drafts a reply without touching any secret. Because it read untrusted content, it has to ask." Point at recipient and exact text. Press **Approve and send**. "Task completed with human approval. The approval was for this text and this recipient, once."

**2:25 · Why it holds (20 s)**
Open **Policies**. "The agent never sends SQL. It picks from a catalog; each operation declares what it touches, and Postgres confirms the declaration matches the plan. No model judging another model."

**2:45 · Close (15 s)**
"This doesn't solve prompt injection. An injection can still change what the agent says. What it contains is the leak: untrusted content and secrets never meet in the same context, and every decision is on the record." Show **Audit Log**.

Shorter version: use the **Live demo** button (bottom right): Submit ticket, Run agent, flip Breaker on, Run agent.
