# Transportation, parking, shopping venues and multi-store outings: design

Status: implemented (`model/transport.R`, `model/outings.R`, world version 11). Written after inspecting
`main` at 42b4db7 and before changing any code; sections 2 and 4 were revised where the implementation
settled details (noted there), and section 7 records how it ended.
Baseline (`npm test` as shipped, R 4.3.3 + NetLogoR 1.0.6 from the app's own `vfs` image):
Node 59/59, shims 23/23, `test-fashion.R` 113/113, `test-world-builder.R` 23/23.

## 0. What the current model assumes (verified)

| # | Assumption | Where |
|---|---|---|
| 1 | One routing grid for every trip: roads/bridges at `road_mps`, every other land tile at `local_mps`, water impassable. Parks, open land, shops and homes are all crossed by car. | `city.R` `macro_speed`, `build_city` |
| 2 | No pedestrian network outdoors; nobody walks outside a store. | — |
| 3 | Parking is a fixed `macro.park_s` added to every trip: no place, no capacity, no occupancy. | `market.R` `new_visits` (`travel`) |
| 4 | A shopping household picks exactly one store (or online, or home) per day. | `market.R` `start_day` |
| 5 | "Millbrook Mall" is four independent points that happen to be close; there is no mall object. | `worlds/default.world.json` |
| 6 | A store visit ends the trip: `leave()` → home. | `store.R` |
| 7 | Accounting assumes one shopping visit per household per day: `mk$budget_left[d$hh[paid]] <-` (duplicates drop all but one), `mk$spend[hb] <-` in `tiers_evening` ("a household makes one shopping visit a day"), `mk$grudge[g] <-`, `tally$share` counts paid visits as households, `tally$in_market` adds ended visits to households, `returns_by_purchase`/`offer_results` key a purchase by (household, day). | `market.R`, `loyalty.R`, `tally.R`, `offers.R` |
| 8 | A household with returns due can make a return trip *and* a shopping trip on the same day, drawn independently, so the two can overlap in time. | `returns_morning` + `start_day` |
| 9 | A coupon is marked used only in the evening, so two visits on one day could both use it. | `offers_evening` |
| 10 | The map drawing shows cars from `d$arrive - d$travel`; no walkers, no parked cars. | `market.R` `travellers_at`, `frames.R` |
| 11 | `km_w × segment.km × route km` is the only travel term in store choice. | `market.R` |
| 12 | Old-season replay tests (v1, v6, v7, v8 fixtures) assert bit-for-bit the seasons older models ran. | `test-fashion.R` |

## 1. Entities and state

All new state lives in plain vectors in global lists (the model's existing webR-speed convention);
NetLogoR remains the authoritative world: every graph below is built from layers read off
`MACRO$world` with `of()`, and the new tile codes are a NetLogoR patch variable.

**Macro tiles (NetLogoR patch `land`).** One character per tile, as now, with physical meaning per mode:

| Tile | Name | Car | Pedestrian |
|---|---|---|---|
| `.` | Open land | no | yes |
| `~` | Water | no | no |
| `p` | Park (paths) | no | yes |
| `w` | Woodland | no | no (paint `-` for a trail) |
| `#` | Building / barrier | no | no |
| `1`–`9` | Homes (local streets) | yes, local speed | yes |
| `=` | Street (with sidewalks) | yes, road speed | yes |
| `+` | Road bridge (with footway) | yes, road speed | yes |
| `H` | Highway (no footway) | yes, road speed | no |
| `x` | Highway crossing | yes, road speed | yes |
| `d` | Driveway / service road | yes, local speed | yes |
| `-` | Footpath / trail | no | yes |
| `f` | Footbridge | no | yes |
| `s` | Pedestrian street / plaza | no | yes |
| `P` | Surface parking lot | only through its facility's vehicle entrances | yes |
| `G` | Parking garage | only through its facility's vehicle entrances | only through its pedestrian exits |
| `m` | Enclosed mall building | no | only through its venue plan |

Areas stay on their own layer and never change any of this.

**Parking facility** (`macro.parking[]`), always placed by the end user, never generated:
`id, name, kind ∈ {kerb, lot, garage}, tiles` (footprint, row/col; kerb: street tiles whose kerb the user marks legal),
`levels, spaces` (explicit; kerb: the spaces the user placed, one per click; bounded by what the footprint can physically hold),
`vehicle_access` (footprint tiles a car enters by; each must touch a drivable tile; a kerb space is on its street),
`pedestrian_access` (footprint tiles a person leaves by), `search_s` (finding a space on a level),
`level_s` (garage: per level climbed), `transfer_s` (space → pedestrian exit: walking in a lot, lifts/stairs in a garage).
Run-time: `pk$t_in`, `pk$t_out`, `pk$vehicle`, `pk$level` per parking event; occupancy at t = #{t_in ≤ t < t_out}.

**Shopping venue** (`macro.venues[]`): `id, name, kind ∈ {mall, strip, district}, stores, parking` (shared facilities),
optional `plan` (`cell_m`, `rows`: `#` wall, `.` corridor, `E` entrance, a letter per storefront) and `storefronts`
(letter → store id). A mall's plan is required and covers its rectangular block of `m` tiles exactly; an `E` on the plan's
edge opens onto the macro tile beyond that edge (a sidewalk, a lot, or a garage's pedestrian exit).

**Store**: as now, plus optional `venue`. Its pedestrian entrance is its pin (standalone, strip, district) or its storefront cell (mall).

**Household**: as now, plus `car` (owns a car; drawn from the segment's `car_share` at the end of the city draws, so earlier draws don't move).

**Outing** (`og`, one row per outing of the day): `hh, kind (shop|return), mode (drive|walk), vehicle (= hh for drivers),
dest (first store), fac (facility parked at, 0 none), fac_tried, park_row, state, ev_at, ev_kind, t_depart, t_home,
at (store whose entrance the shopper is at), n_visits, first_v, last_v, spent, want` (shopping list: categories x),
`got` (categories bought), `grudge_today` (brands), `margin` (utility margin of the chosen destination over home), `ended` (reason).

**Visit** (`d`, as now, one row per store/online visit): grows during the day; new fields `outing, stop` (1 = destination,
2+ = follow-on). `d$budget` at a visit's creation = the household's budget left less everything paid earlier in the outing.

**Outing legs** (`ol`): `outing, kind (drive|park|walk|inside), t0, t1, graph, from, to` — the physical chronology; the map
draws from it and the tests check it.

**Purchases**: the ledger, unchanged in meaning, gains a `visit` id so each purchase is distinct.

## 2. Journey state machine

```
HOME ─depart(t0)→ DRIVING ─reach facility f→ [space free?] ─yes→ PARKING(search+level) → TRANSFER → WALKING → AT_DOOR(s) → INSIDE(v)
  │                         └─no→ next facility for s (if the destination still beats home) │ else DRIVING home (ended: "couldn't park")
  └ walkers: WALKING → AT_DOOR(s)
INSIDE(v) ─leave (d$gone)→ AT_DOOR(s) ─decide→ WALKING → AT_DOOR(s') → INSIDE(v') …
                                       └ end → WALKING to f → TRANSFER → UNPARK (space released at t_out) → DRIVING → HOME
                                                 walkers: WALKING → HOME
```

Times: drive = vehicle field time; park = `search_s + (level-1)·level_s`; transfer = `transfer_s`; walk = pedestrian field
length / outdoor walking speed. Every leg starts where the previous one ended (checked). A space is occupied from the
car's arrival in it to the moment it pulls out; a car pulls out only after its own shopper has walked back to it, at
the facility it parked in. A full facility: the shopper tries the next facility serving the store (driving there on the
road graph) while the destination's margin over staying home still covers the extra cost; otherwise drives home.
An outing ends: shopping list satisfied, budget gone, no reachable candidate before last entry, or the "go home" option
wins the continuation choice. A household's outings run one after another: a shopping outing whose departure falls
while its return trip is still out waits until the household is home (or is dropped if that is past last entry).

Processing order in each one-minute step (as implemented): the floor (as before), then the outing events due before
the step's end, a kind at a time in causal order (store exits, arrivals home, departures, then parking arrivals in the
order they arrive), then the shoppers who reached a store's door within the step come in, and so on until nothing
else falls due in the step. Every space freed before a car arrives is known when that car asks for one; a car's
occupancy runs from its arrival to the moment it pulls out. (Grouping by kind, rather than one strict time order
across kinds, made a market day about twice as fast; it can change which of two cars arriving at one facility
within the same minute, both created in that minute, takes its last space. Capacity is never exceeded.)

## 3. Changes for several visits per household per day

| Component | Change |
|---|---|
| Visit scheduler | visits are created when the shopper reaches a store door (`add_visits`), inserted into `d$by_arrival` in time order |
| Budget | `d$budget` from the outing's running total; evening update `bin_sum` by household (sales + delivery − refunds) |
| Store choice | the morning logit picks the destination (unchanged structure, travel term replaced, see §4); continuation logit at each door (§4) |
| Transactions | unchanged per visit; ledger lines carry the visit |
| Loyalty | `tiers_evening` adds spend with `rowsum` over (household, brand) |
| Grudges / last brand | `tabulate`-based increments; last brand = the latest purchase by time |
| Coupons | marked used at the till, the household's coupon row recomputed at once, so no second visit can use it |
| Offers | purchases keyed by (household, day, brand), aggregated before refunds are netted off |
| Reporting | in-market and share count households; visits, follow-on visits, outings, unique shoppers, purchases and transactions are separate tallies |
| Online / returns | online visits unchanged (no trip); a return trip is an outing with one return visit, travelling physically |

## 4. Generalized travel cost

One-way generalized cost of reaching store s from home by car via facility f, in **utility units**:

C(h,s,f) = κ_seg · ( β_d·T_drive + β_p·T_park + β_w·T_walk )

| Symbol | World field | Unit | Meaning | Range | Default (assumed) |
|---|---|---|---|---|---|
| β_d | `market.drive_w` | utility / min | in-vehicle time | 0–0.5 | km_w × road_mps × 0.06 (0.132 in the default world) |
| β_p | `market.park_w` | utility / min | search, ramps, lifts | 0–1 | 1.5 β_d |
| β_w | `market.walk_w` | utility / min | walking outdoors and in malls | 0–1 | 2 β_d |
| κ_seg | segment `km` | × | the segment's dislike of travel (existing) | 0–4 | as the world has it |

Walking: C = κ·β_w·T_walk(home→s) when a pedestrian route exists within `market.max_walk_km`. The household uses its
cheaper available mode, and the facility with the lowest C for that store. **This term replaces `km_w × κ × km`**; it is
not added to it, so travel is counted once. The segment radius still bounds route km (of the chosen mode). A destination
also gets `cluster_w × log(1 + Σ exp(W(h,s') − κβ_w T_walk(s→s')))` over the other stores within walking range
(the value of shopping on), default `cluster_w` 0.3 (assumed). Once parked, only walking enters a continuation choice:
−κβ_w(T_walk(s→s') + T_walk(s'→f) − T_walk(s→f)).

None of these is empirically calibrated: no calibration data exists in the repository. All are world settings,
the defaults are stated assumptions, and `tools/test-transport.R` checks the direction of their consequences
(cost falls with a trail, a footbridge or a closer facility; a fuller budget or fewer categories left makes going
on less likely). No sensitivity sweep over the weights' values was run (section 7).

As implemented, β_f (a parking fee) does not exist: parking has no price (section 6). The facility memory: a
household turned away by a full facility adds 1 to its memory of that facility, which fades by the market's
`memory` each day and costs `grudge_w` per unit in the trip's utility, as a bad visit to a brand does.

## 5. Calibrated versus assumed

Calibrated: nothing in this change. Assumed and configurable: β_d, β_p, β_w, β_f, cluster_w, max_walk_km, walk_mps
(1.3 m/s), m² per space (25, the upper bound a lot or garage level can hold), kerb metres per space (6, the upper bound on a kerb tile), car_share. Each is documented where it is set.

## 6. Product decisions (answered)

1. **Parking is built by the end user, never by the model.** Kerb spaces, lots and garages exist only where the world
   file places them. A road gives connectivity, not permission to park. Older worlds upgrade with `parking: []` and
   `venues: []`: they load and run, but a driving outing needs a facility, so until the user builds parking their
   households can only walk; the world check lists every store and venue that cannot be reached by car or on foot,
   with its tiles, without repairing anything. The bundled worlds get explicitly authored, editable, removable parking.
2. **No parking economics.** No fees, revenue, parking transactions or budget deductions. Parking acts on choice
   through availability, search and access time, and walking distance only.
3. **Replay tests.** The four replays of older models' seasons assumed the old travel physics. Their non-travel
   invariants (upgrade contents, no online orders or returns where the old world had none, deterministic runs) stay;
   the exact-season comparison is replaced by independently defined expectations of the upgraded world under the new
   physics (no parking → no driving outings, no parking events, every visit made on foot within walking range),
   and the cause is documented in the test.

## 7. As built

**Files.** New: `model/transport.R` (tile permissions, graphs, fields, facilities, venues, checks, warnings,
travel costs), `model/outings.R` (outings, parking occupancy, legs, continuation choice, visits made at the door,
positions), `js/fashion/transport-editor.js` (the Parking & venues layer and the mall plan editor),
`tools/build-transport.mjs` (the bundled worlds' parking and venues, built explicitly), `tools/test-transport.R`
and `tools/transport-worlds.R`, `tools/test-browser.mjs`, `tools/fixtures/v10-default.world.json`.

**World version 11.** `macro.park_s` is gone; `macro.walk_mps`, `macro.parking` and `macro.venues` are new;
a store may name its `venue`; the market's `km_w` became `drive_w`, `park_w`, `walk_w`, `cluster_w` and
`max_walk_km`; each segment has a `car_share`. New tiles: `w # - f H x d P G m` (city.R). An older world upgrades
with no parking and no venues (`upgrade_v10`), its tiles unchanged: it loads and runs on foot, and the warnings
(the map editor's "Getting there" card) name every store no car can reach.

**Parameters, as shipped** (all assumptions, all world settings except the bounds):

| Setting | Default world | Upgrade from v10 | Meaning |
|---|---|---|---|
| `market.drive_w` | 0.132 / min | km_w × road_mps × 0.06 | dislike of a minute driving |
| `market.park_w` | 0.198 / min | 1.5 × drive_w | of a minute finding a space, climbing, walking to the exit |
| `market.walk_w` | 0.264 / min | 2 × drive_w | of a minute walking |
| `market.cluster_w` | 0.3 | 0.3 | pull of the stores one could walk on to from a destination |
| `market.max_walk_km` | 2 | 2 | the longest walk (home to store, facility to store, store to store) |
| `macro.walk_mps` | 1.3 m/s | 1.3 | walking outdoors and in malls |
| `segment.car_share` | 1 | 1 | households with a car |
| `M2_PER_SPACE` | 25 m² | — | the most a lot's or a garage level's area holds (a bound, not a capacity) |
| `KERB_M_PER_SPACE` | 6 m | — | the most a street tile's kerbs hold |
| facility `search_s`, `level_s`, `transfer_s` | set per facility | — | its own times |

**Units counted apart** (tally.R): outings home by how they ended, by car and on foot; outings by number of
stores visited; households in stores; destination visits and follow-on visits by store; purchases (paid visits);
units (ledger lines); cars parked, cars turned away and the most at once, by facility.

**Not done, or done differently:**
- Multiple parking stops in one outing: the state allows it (a facility per outing, changed when one is full),
  but a shopper never moves the car to park again nearer another store; they walk, within `max_walk_km`.
- No sensitivity sweep over β values was run; the tests check directions, not elasticities.
- A shopper who finds every facility for a store full goes home; they don't choose a different store instead.
- Return trips are made on the household's cheapest way to the brand's nearest store; one that can't park posts
  its items back that day.
- Performance: a market day of the default world takes about 2.2 s in native R (1.1 s before) and about 5 s in
  webR (1.5–1.9 s before), measured on the same machine (section in README).
