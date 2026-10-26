---
surface: lightning
org: myAdminAlias
user: fleet.manager        # Login-As by the alias's admin
agent: Fleet Assistant     # only needed when the user has several employee agents
hideLoginAsBanner: true    # a clean header for a deck
---
# The fleet manager's morning check

1. Which stations are low on bikes this morning?
   - expect: station
   - max-seconds: 30
2. Draft a rebalancing plan that moves bikes from the fullest stations to those.
   - expect: move|plan
3. Create a task for the night crew to do it.
   - expect-button: /confirm|create/
4. click: /confirm|create/
   - expect: created|task
