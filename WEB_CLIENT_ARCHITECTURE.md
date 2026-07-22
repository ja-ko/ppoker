# ADR: Shared Client and Web Architecture

## Status

Accepted.

## Context

Native and browser clients share protocol and client behavior. The ownership
boundary must remain clear without turning planned peer sharing into a
premature synchronization design.

## Decisions

### Core Client

`ppoker-core::client::Client` is one nongeneric portable client. It owns its
boxed transport and shared connection state: status and errors, authoritative
room state, local identity and vote, activity log, round number, completed-round
history, statistics, and snapshot revision.

Native and browser transports implement the same narrow transport interface.
`Client::poll()` applies transport events and returns a `PollOutcome` containing
ordered `ClientUpdate` values. Consumers may apply local policy to those updates
without owning or merging a second copy of shared state.

### History And Future Sharing

History remains core-owned so planned future peer sharing starts from one
authoritative local history rather than separate native and browser histories.

No peer synchronization protocol or model, peer election, identity scheme,
ordering or conflict rule, or merge algorithm is implemented or designed now.
Current APIs and data shapes are not a partial synchronization design.

The current `HistoryEntry` perspective fields are intentionally not redesigned.
Its `votes` retain each `Player.is_you` value and `own_vote` retains the local
vote. Any future identifiers, provenance, clocks, or merge metadata require a
separately reviewed synchronization design.

### TUI Policy

Elapsed round timing is TUI-local. Native `App` tracks round start instants and
completed-round durations; neither is added to core snapshots or
`HistoryEntry`.

Native notifications and auto-reveal remain `App`-owned. This includes focus and
notification eligibility, timers, terminal bell and desktop delivery, and
auto-reveal eligibility and cancellation. Manual reveal remains a core command.

These policies do not enter core state, WASM options or snapshots, or the
authored TypeScript API.

### WASM Boundary

The WASM facade is thin. It validates and converts options and snapshots,
provides the browser transport and clock, delegates lifecycle and commands to
the core `Client`, and translates errors. It does not maintain parallel domain
state or native application policy.

### Authored Web Client

The web package exposes one authored `PokerClient` through the asynchronous
`createPokerClient()` factory. Creation initializes WASM and constructs the
generated facade; importing the package has no WASM or socket side effects.

That client owns the generated instance, immutable cached snapshot, polling,
subscriptions, command delegation, and close/dispose lifecycle. `connect()`
starts polling independently of subscriber count. There is no second public
store, read-only wrapper, or alternative lifecycle.

React provides only a non-owning provider and hooks over the same client.
Provider mount and unmount do not connect or close it.

## Test Ownership

Core tests own models, protocol, shared state transitions, history, commands,
and the transport contract. Native tests own TUI adaptation, round timing,
notifications, auto-reveal, and the native socket adapter. WASM tests own the
JavaScript ABI and browser transport. TypeScript tests own the authored client,
React integration, public types, and package behavior.

Normal Cargo tests and `pnpm run check` are deterministic. The two live upstream
proofs are ignored by default and run in separate `live-native` and
`live-browser` workflow jobs.

Branch protection should mark `live-native` and `live-browser` as required
checks. Keeping them separate makes upstream native and browser failures
attributable; each proof uses unique rooms and bounded waits and retries.

## Consequences

Future sharing work begins with core-owned history but must explicitly design
its protocol and merge semantics. Native presentation policy can evolve without
expanding the portable API. Web consumers have one lifecycle, and live upstream
failures remain distinct from deterministic validation.
