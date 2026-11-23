---
"planboard": patch
---

Jira lookups through acli no longer pile up when Atlassian sign-in is down: each call is killed after 90 seconds, at most four run at once, and an outage pauses all acli calls with a growing delay instead of retrying.
