---
surface: messaging
site: https://example.my.site.com/rides/
org: myAdminAlias          # its admin logs in to the site as the rider (Login-As)
user: rider.demo
---
# A signed-in rider extends a rental

1. Hi
2. I'd like to extend my current rental by one hour.
   - expect: code|verify
3. type-from: prompt one-time code   # emailed to the rider: type it in the UI or the terminal when asked
   - expect: extend|confirm
4. click: /confirm|yes/
   - expect: extended|until
   - expect-not: sorry|went wrong
