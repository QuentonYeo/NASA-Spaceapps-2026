# Local API performance check

Measured on 2026-11-15 against the running development backend. These are individual observations, not load-test percentiles. The direct runs used http://127.0.0.1:8000 with polling every 250 ms; polling and server scheduling can increase detection latency. They do not measure browser painting.

| Query | Accepted | First image | First batch finished | Result |
| --- | ---: | ---: | ---: | --- |
| Prepared Vesta | 0.016 s | 0.037 s | 0.037 s | 3/3 previews, demo_cache |
| Vesta with demo bypassed | 0.030 s | 27.923 s | 42.394 s | 3/3 previews, archive |
| Pinwheel field first batch | 0.029 s | 33.200 s | 66.666 s | 11 ready, 1 failed of 12 requested; 246 exposures discovered |

The archive repeats may reuse process-local FITS data and are not guaranteed cold-cache measurements. Exposure discovery still took about 23-24 seconds. An earlier localhost run returned cached Vesta in 4.153 seconds and archive Vesta in 38.465 seconds; localhost had about two seconds of overhead per request that was absent with direct IPv4. Its Pinwheel polling request timed out before the first batch finished.

The 15-second deadline applies only to waiting for a search worker. It must not be used as an overall IRSA-query deadline: successful archive searches exceeded it. HTTP API requests retain their separate 20-second timeout; search creation returns an ID before archive discovery finishes. New searches from one tab supersede that tab's older queued work. Running archive operations remain subject to existing network timeouts and retry budgets.
