---
surface: messaging
site: https://example.my.site.com/rides/
viewport: mobile           # the widget full screen, as on a phone
record: [gif, screenshots]
---
# A rider reports a damaged bike, then asks for a person

1. Hi
2. The bike I just rented has a flat tire and the brakes feel loose.
   - expect: safe|stop|sorry
3. I'd like to talk to someone, please.
   - expect: transfer|connect|person|agent
