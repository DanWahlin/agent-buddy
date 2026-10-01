# Vendored from esp32-agent-companion

`protocol.ts`, `state-coordinator.ts` and `state-store.ts` are taken unmodified
from this repository's [`daemon/src/`](../../../../../daemon/src), with
`state-coordinator.test.ts` and `state-store.test.ts` from
[`daemon/test/`](../../../../../daemon/test) kept alongside so the vendored
copies stay verified.

They are a snapshot from mid-September 2026 (`state-coordinator.ts` as of
`de20670`), and `daemon/src` has moved on since. Importing from there instead of
copying is the way to close that gap, and is a separate change.

Copyright belongs to Dan Wahlin, who has approved this derivative work. The
repository carries no LICENSE file, so that approval is what permits
redistribution - see the credits in [desktop/README.md](../../../../README.md).

The two vendored tests are changed in exactly two ways, both unavoidable: their
imports point at this folder, and the file-mode assertions in
`state-store.test.ts` are skipped on Windows, where `chmod` cannot set POSIX
bits. The sources themselves are unmodified; the transport,
the socket paths and the hook installer are ours and live outside this folder,
because upstream's are USB- and Copilot-CLI-specific and have no Windows path.
