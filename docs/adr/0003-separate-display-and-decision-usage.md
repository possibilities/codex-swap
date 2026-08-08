# 0003: Separate display-grade from decision-grade usage

A stale last-good measurement is still worth showing a human with its age and
last error, but it must not silently drive automatic account selection — so
the snapshot schema carries `lastGoodUsage` (display-grade, always the newest
success) separately from `usage.measurement` (present only while decision
trust rules hold). This ports Claude Swap's core safety property: transient
failures never blank data, and unknown or expired data never wins a selection
by default.
