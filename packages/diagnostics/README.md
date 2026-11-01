# Diagnostic logs

`DiagnosticLog` writes metadata and errors synchronously to a private JSONL file. Each writer uses a unique process/PID/start identifier, including when several runtimes run at once. Errors also go to a separate `.errors.jsonl` stream without sampling.

At 10 MiB, a segment is renamed and compressed asynchronously to `.jsonl.gz`. The original is deleted only after the gzip file is installed successfully. Interrupted or failed compression leaves the original available; startup recovers files belonging to dead processes. `flush()` waits for pending compression and retention work. `close()` also archives the final live segments. Fatal process handlers flush before exiting.

Defaults are 7 days for ordinary archives and 30 days for error archives, within a shared 256 MiB budget. Retention removes ordinary archives before error archives; error history is finite too. The budget counts all recognized log files. Live streams and in-progress compression sources are protected, so disk use can temporarily exceed the budget until compression and cleanup finish. Configure options directly or through these environment variables:

| Option | Environment variable | Default |
| --- | --- | --- |
| `maxBytes` | `COILCOIL_LOG_MAX_BYTES` | 10 MiB |
| `maxTotalBytes` | `COILCOIL_LOG_MAX_TOTAL_BYTES` | 256 MiB |
| `retentionDays` | `COILCOIL_LOG_RETENTION_DAYS` | 7 |
| `errorRetentionDays` | `COILCOIL_LOG_ERROR_RETENTION_DAYS` | 30 |

`listDiagnosticLogFiles()` discovers current, legacy and compressed files. `readDiagnosticLogFile()` and `tail()` read gzip transparently. Desktop file preview opens compressed logs as read-only text; sharing/downloading the archive keeps the original gzip bytes.

Local and relayed entries use the same redaction. Request/message bodies, full tool arguments/results, commands and credentials are omitted. Use `diagnosticValueSummary()` for byte counts, fingerprints and parameter shapes. Numeric token metrics, paths, durations, operation IDs and schema field names remain available. Error messages, causes and stack frames are bounded and credential-redacted. An individual entry is bounded to 96 KiB; excessive metadata is omitted while its error is retained.
