# Example: an e-bike rental service

A city e-bike rental service with docking stations. Its agents:

- **A service agent on the website** (Embedded Messaging): prices, stations with bikes available, reservations,
  rental extensions for signed-in riders (after a one-time code), and hand-off to a person for safety issues.
- **An employee agent in Lightning** for the fleet team: station levels, rebalancing plans, maintenance tasks.

The scenarios use placeholders: replace `myAdminAlias` (an sf CLI alias of an admin), the site URL, and the
users (`rider.demo` for a rider with a community user, `fleet.manager` for an internal user) with yours. Your
agents need topics and actions that answer these questions for the `expect` checks to pass; otherwise use these
files as templates for your own scenario.

| File | Surface | Who | Shows |
| --- | --- | --- | --- |
| `01-guest-prices-and-stations.md` | Messaging | guest | answers with numbers, a reservation card (`expect-button`), timing (`max-seconds`) |
| `02-rider-extend-rental.md` | Messaging | rider, Login-As | a one-time code typed live (`type-from: prompt`), a confirmation card (`click`) |
| `03-damaged-bike-handoff.md` | Messaging, mobile | guest | a safety answer, then a hand-off to a person (the recording ends there) |
| `04-fleet-manager-morning.md` | Lightning panel | fleet manager, Login-As | picking an agent (`agent:`), a plan, a task created after confirmation |
| `05-batch.csv` | both | several | several conversations in one sheet, run in parallel |

Run them with `afrec run --dry-run` first (or `afrec run examples/ebike --dry-run` from a clone): it shows who signs in where, and what runs in parallel.
