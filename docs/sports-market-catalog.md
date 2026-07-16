# Sports market catalog

The monitor uses Polymarket Gamma Sports metadata instead of hard-coding one
league's URL format. `largeTradeScopes` controls large-trade monitoring.
`HOLDER_EVENT_SCOPE_PATHS` controls Top Holder schedule discovery.

## Configured scopes

The checked-in `config/watchlist.json` and the `.env.example` holder scope list
contain these user-facing names:

- Baseball: `mlb`
- Combat: `ufc`
- Tennis: `atp`, `wta`, `itf`, `atp-doubles`, `wta-doubles`
- Cricket: `mlc`, `international`, `lpl`, `t20-blast`, `shpageeza`
- Basketball: `wnba`, `bsn`, `nba`, `nba-summer-league`
- American football: `cfl`, `nfl`, `cfb`
- Lacrosse: `pll`, `wll`
- Soccer: `bolivia-lfpb`, `uel`, `mls`,
  `uefa-europa-conference-league`, `chinese-super-league`,
  `brazil-serie-a`, `liga-mx`, `australia-cup`, `k-league`,
  `primera-division-argentina`

Some names are aliases for the current Gamma tag or series slug:

- `mlc` -> `major-league-cricket`
- `lpl` -> `lanka-premier-league`
- `shpageeza` -> `cricshpageeza`
- `atp-doubles` and `wta-doubles` -> their matching series slugs
- `liga-mx` -> `mex-2025` and `mex-2026`
- `australia-cup` -> `soccer-auc`
- `primera-division-argentina` -> `primera-divisin-argentina` and season series
- `uel` -> the current UEFA Europa League tag/season series
- `uefa-europa-conference-league` -> `europa-conference-league`
- `bsn` falls back to Gamma public search when no tag/series exists

The resolver fails closed when a scope cannot be resolved. It does not scan
the entire Polymarket site just because one configured alias is invalid.

## Holder target types

Holder monitoring reads the official `sportsMarketType` field. The default
`HOLDER_MARKET_TYPES` set includes:

- Main game lines: `moneyline`, `spreads`, `totals`, `match_handicap`
- Baseball: first-five winner/spread/total, `nrfi`, and extra innings
- UFC: `ufc_go_the_distance` and `ufc_method_of_victory`
- Tennis: match winner, match totals, set winner, set handicap, and set totals
- Cricket: completed match, first/second innings runs, and match-to-go-till

Player props, futures, quarter/half markets, toss markets, exact scores, and
other unlisted types are excluded by default. Add an official type name to
`HOLDER_MARKET_TYPES` when a broader Holder scope is intentional. The
World Cup soccer rules remain unchanged: spreads are limited to 1.5/2.5 and
full-game totals to 1.5 through 7.5.

Large-trade monitoring does not apply this Holder type filter. It monitors all
markets found inside the configured `largeTradeScopes`, including custom sports
markets, and then applies the global threshold and split-fill rules.

## Performance safeguards

- Holder schedule discovery keeps only event slugs dated yesterday through the
  configured `HOLDER_SCHEDULE_LOOKAHEAD_DAYS` (default 3 days).
- Holder API reads run with bounded concurrency; state writes remain sequential.
- When the catalog has more than `LARGE_TRADE_MARKET_FILTER_MAX_CONDITIONS`
  conditions (default 1000), large-trade monitoring uses one public candidate
  query and filters it against the configured catalog instead of issuing
  hundreds of market-filtered requests.
