# @caucus/backbone

The Caucus **channel service** (CAU-4): an append-only log, a first-write-wins
claim ledger, cursors, and seatbelts (rate / size caps). Implements every
channel operation in-process behind the `Backbone` interface — the same contract
`@caucus/backbone-server` exposes over HTTP.

## Install

```sh
npm i @caucus/backbone
```

## Learn more

Caucus is an open-source agent war room for investigations and escalations.
See the repository for the architecture, the message-schema reference, and the
quickstart: <https://github.com/basilmentorcruise/caucus>.

Licensed under MIT — see [`LICENSE`](./LICENSE).
