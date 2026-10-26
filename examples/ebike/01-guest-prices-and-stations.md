---
surface: messaging
site: https://example.my.site.com/rides/
---
# A visitor checks prices and finds a bike

1. Hi
2. How much does an e-bike cost for two hours?
   - expect: /\d/
   - expect-not: sorry|went wrong|don't know
   - max-seconds: 20
3. Which stations near the central train station have bikes right now?
   - expect: station
4. Can I reserve one for 30 minutes?
   - expect-button: /reserve|confirm|book/
