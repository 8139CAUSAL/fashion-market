# Fashion retail simulation: plan

*Draft for your review, 2026-09-24. No code has been changed. Nothing in this
document is built yet. Section 9 lists the decisions I need from you.*

---

## 1. What we're building

A single multi-tab project in the Workbench: **a fashion retail market you can
run for a season and zoom into, down to one shopper in one store.**

- Several **brands** run **fleets of stores** across several **geographies**.
  Some stores share a brand and some don't. Each brand has its own strategy
  controls.
- **Shoppers** decide whether to shop today, which store to visit, what to
  pick off the rack, whether to try it on, and whether to pay or walk out.
- You can **open any store** and watch its shoppers walk the floor, browse
  racks, queue for the fitting rooms and pay at tills staffed by **cashier
  agents**, with optional **sales assistant agents**.
- Every number in every report is **the sum of what individual agents did**.
  The store you're watching is part of the same simulation the market
  reports come from. It isn't a separate animation.

It also includes the changes to the application this project needs (section
6) and the packaging that makes it portfolio-ready (section 7).

### The questions it answers

These are real questions for a retail or supply-chain analytics audience.
Each one has a control you can move and a chart that answers it.

1. **Staffing.** How many cashiers and assistants does a store need on a
   Saturday afternoon? What do too few cost in walk-outs, and too many in
   wages?
2. **Size availability.** How much revenue is lost because the shopper's
   size isn't on the rack? How much does allocating by each store's size
   mix, or having an assistant fetch from the stockroom, win back?
3. **Price and promotion.** What does a price cut or a local promotion in
   one metro do to our share? Whose share does it take, and what does it do
   to margin?
4. **Markdown.** When should a style be marked down? What's the trade-off
   between sell-through and margin?
5. **The funnel.** Where do we lose shoppers between walking in and paying,
   and why?

### The 60-second tour (what a reviewer sees)

1. The link opens straight into the project. A season runs day by day on the
   market map, and brand shares shift.
2. Click one of our stores. The Store tab opens on its floor plan, and you
   watch shoppers move between racks. Queues form at the fitting rooms and
   the tills. The flow diagram shows which queue is the bottleneck.
3. The Funnel tab shows the cost: shoppers walking out of the till queue.
4. Add a cashier and let the week run again. The walk-outs drop, conversion
   rises, and our share on the Market tab moves.
5. Open **Edit** to see the whole thing is an interface description and R
   code, running in the browser.

---

## 2. How the reference images map to the product

| Image | What we take from it | Where it lands |
|---|---|---|
| **_consumer_market** | Separate regions with shoppers as dots coloured by brand; a strategy panel per company; local promotion buttons per region and brand; "pick a random kid" to explain one agent's latent preference and the switching threshold; share pie, sales dynamics, revenue by company | **Market** tab |
| **_strategy_control** | Our levers set against competitors' (bars beside sliders); market share history as stacked area (addressable, ours, other); total revenue and revenue per user, with its history | **Market** tab strategy panel and KPIs. Revenue per user becomes **spend per customer** and **average transaction value** |
| **_salesFunnel** | Stages as circles holding live dots; conversion % between stages; bars of losses by reason above each stage; staff team panels with a skill slider | **Funnel** tab, rebuilt with fashion stages (section 3.2) |
| **_product_portfolio** | A lifecycle pipeline with bubbles (colour = type, size = value) and counts on the arrows between stages; a budget slider; a rule that retires products | **Assortment** tab: on order → full price → markdown → clearance. The rule is a markdown rule, and the budget is the season's buy |
| **resteraunt_flow** (Mercado / Mapa de Calor / Lógica / Câmeras) | The tab structure itself. A floor plan with fixtures coloured by category and agents walking. A footfall heat map | **Store** tab (floor and heat map). The tab bar across the whole project |
| **resteraunt_flow2** (Lógica), **resteraunt_que1** | A process-flow diagram with live counts, queue lengths and staff utilisation; queue and utilisation charts | **Store** tab flow panel and charts |
| **sushi** | A clothing store: fitting rooms, wall racks, centre tables, a till with a receipt counter, entrance and exit. Parameters: traffic per hour, minutes per try-on, seconds to scan an item, maximum queue at the fitting room and the till. KPIs: profit over time, average receipt, receipts per day, service time, customers lost from each queue, stock by category | The store model's parameters and the **Store** tab KPIs, almost one-for-one |
| **multitab_resteraunt** (Statistics) | A dense statistics page: satisfied vs. unsatisfied, staff utilisation, a distribution with its summary statistics, fill rate, demanded vs. filled | **Scorecard** tab |
| **policy_example_columbine** | Not used. It's a floor plan beside a parameter panel, which the Store tab already covers | — |

**Left out: the 3D "Câmeras" view.** The renderer is 2D, and a 3D engine
would be a project of its own.

---

## 3. The tabs

Tabs run across the top of the stage, like the Mercado / Mapa de Calor bar.
A **header** sits above them and shows on every tab. The layout sketches
below are rough. The real layouts use the Workbench's grid.

### Header (every tab)

```
┌ Run ─────────────────────────────┐ ┌ Clock ────────────────┐ ┌ Headline ──────────────────────────────┐
│ setup   go   pace [season|watch] │ │ Week 3 · Sat 14:20    │ │ our share 27% · sales $1.24M · conv 31% │
└──────────────────────────────────┘ └───────────────────────┘ └────────────────────────────────────────┘
 [ Market ]  [ Funnel ]  [ Store ]  [ Assortment ]  [ Scorecard ]
```

- **pace**
  - *season*: one tick is one day. The market, assortment and scorecard move
    day by day.
  - *watch*: one tick is a few seconds of store time, so you can watch
    shoppers walk.
  - Both paces run the same simulation (section 4.4).

### 3.1 Market

```
┌ Strategy ───────────────────────────────┐ ┌ The market ─────────────────────────────────────────┐
│             Ours   Value  Premium  Fast  │ │  Metro 1               │  Metro 2                  │
│ price index  ▮▮     ▮▮     ▮▮      ▮▮   │ │   · · households       │   · ·  ■ stores           │
│ promo depth  ▮▮     ▮▮     ▮▮      ▮▮   │ │   (colour = brand they  │                          │
│ marketing    ▮▮     ▮▮     ▮▮      ▮▮   │ │    last bought from)   │                           │
│ cashiers     ▮▮     ▮▮     ▮▮      ▮▮   │ │────────────────────────┼───────────────────────────│
│ assistants   ▮▮     ▮▮     ▮▮      ▮▮   │ │  Metro 3               │  Metro 4                  │
│ local promo  [O][V][P][F] per metro     │ │                        │                           │
└──────────────────────────────────────────┘ └─────────────────────────────────────────────────────┘
┌ Share ┐ ┌ Share history (stacked) ┐ ┌ Sales by brand ┐ ┌ Share of wallet by segment ┐ ┌ One shopper ┐
```

- **Map.** One map with four regions, one per metro, laid out like the
  consumer-market picture.
  - Dots are household agents, coloured by the brand they last bought from
    (grey if they haven't bought yet).
  - Squares are stores in their brand's colour, sized by today's traffic.
  - Region names and store names are drawn on the map.
  - **Clicking a store opens it in the Store tab.**
- **Strategy.** The same levers for every brand, so you can play any of
  them. The levers are price index, promotion depth, marketing reach,
  cashiers per store, assistants per store, and a local promotion toggle for
  each brand in each metro (the R/G/B buttons).
- **Charts**
  - Market share (donut)
  - Share history (stacked area)
  - Sales by brand (bars)
  - Share of wallet by shopper segment (stacked bars)
  - Spend per customer
- **One shopper.** "Pick a random shopper" shows their appeal score for
  each brand, the threshold that would make them switch, and their segment,
  budget left and recent experiences. This is the "latent preference of kid
  #1789" panel from the consumer-market picture.

### 3.2 Funnel

```
   lost: not in market     lost: went to a rival    lost: nothing in my size    lost: queue too long   lost: queue too long
   ▮ ▮                     ▮ ▮ ▮                    ▮ ▮ ▮ ▮                     ▮ ▮                    ▮ ▮
 ( In market ) ──62%──▶ ( Visited ) ──48%──▶ ( Picked items ) ──71%──▶ ( Tried on ) ──80%──▶ ( Paid $ )
    · · ·                  ·:·:·                 ·:·:·:·                  ·:·                    ·:·
 filter: brand ▾  metro ▾  store ▾
┌ Sales assistants: count · skill ┐   ┌ Cashiers: count · scan speed ┐
```

**Fashion stages and their losses.** Each loss reason is recorded by the
agent at the moment it happens.

| Stage | Losses, by reason |
|---|---|
| In market → Visited | stayed home; went to a rival brand |
| Visited → Picked items | nothing appealed; too expensive; **not in my size** (a size stockout) |
| Picked → Tried on | **left the fitting-room queue**. Some items, like accessories, skip the try-on |
| Tried on → Kept | didn't fit or didn't like it |
| Kept → Paid | **walked out of the till queue** (the items go back to the rack) |

- **The circles hold live dots**, one per shopper at that stage today, as in
  the sales-funnel picture.
- **Staff panels.** Sales assistants (count, skill) and cashiers (count,
  scan speed) for the selected brand, like the image's Sales Force and
  Credit Review Team panels. They are the same variables as on the Market
  tab, so there's one setting and two places to change it.
- **Filters** show the funnel for the whole market, one brand, one metro or
  one store.

### 3.3 Store

```
┌ Ours · Metro 1 · mall format   ◀ prev  next ▶ ┐
┌ Floor ──────────────────────────────────────┐ ┌ Footfall heat ─────────────────────┐
│ W D D D D   T T T T   K K K K   O O O O  F F │ │                                    │
│ W                                        F F │ │  (where shoppers walked today)     │
│ W   t t     t t       t t      S S S S   F F │ │                                    │
│ W A A A A             $ $ $    R R R R R R R │ │                                    │
│ W W W W W W W W E E E W W W W W W W W W W W │ └────────────────────────────────────┘
└─────────────────────────────────────────────┘
┌ Flow: Entrance 212 → Browse 38 → Fitting rooms 4/4 busy, queue 6 (91%) → Tills 2/2, queue 7 (97%) → Exit ┐
┌ Today: traffic · conversion · avg receipt · units per receipt · receipts · waits · walk-outs ┐
┌ Queues over the day ┐ ┌ Staff utilisation ┐ ┌ Sales by hour ┐ ┌ Stock by category ┐
┌ Follow a shopper: segment, budget, size, basket, and the log of their visit ┐
```

- **Floor plan.** Racks by category (denim, tops, knitwear, outerwear,
  dresses, shoes, accessories), front tables for new arrivals and
  promotions, fitting rooms, tills, a stockroom, the entrance, and walls.
  Zone names are drawn on the plan.
  - Shoppers are dots coloured by what they're doing: browsing, carrying
    items, queuing, trying on, paying, or leaving empty-handed.
  - Staff are squares: cashiers at the tills, assistants on the floor.
- **Heat map.** A second view of the same floor showing where shoppers
  walked today.
- **Flow.** The process diagram from the "Lógica" and queue pictures, drawn
  live: counts at each step, servers busy out of total, queue lengths,
  utilisation, and the shoppers lost at each queue.
- **Store KPIs** from the sushi picture: traffic, conversion, average
  receipt, units per receipt, receipts, fitting-room and till waits,
  walk-outs, sales, staff cost, and stock by category over the day.
- **Follow a shopper.** Click a shopper on the floor, or pick one at random,
  to see who they are and a log of their visit. For example:
  > 14:02 entered · 14:04 denim: no 32 in stock · asked an assistant, who
  > found one in the stockroom · 14:11 fitting-room queue (3 ahead) · 14:19
  > kept 2 of 3 · 14:21 till queue (6 ahead) · 14:23 walked out.

  This is where "agents actually shop" becomes visible, and where it's
  plain that each report line is made of trips like this one.
- **Store formats.** Three floor plans: flagship, mall and small or outlet.
  They differ in size, fitting rooms and tills. Each plan is written in the
  model as a text picture like the one above, one character per half-metre,
  so it's easy to read and edit. Walking routes on each plan are computed
  once at setup, so walking is a lookup (as the Göttingen routes are).

### 3.4 Assortment

```
┌ Lifecycle ─────────────────────────────────────────────────────────────────────────┐
│  On order ──12──▶ Full price ──9──▶ Markdown ──4──▶ Clearance / sold through        │
│   ○ ○              ◯  ○ ◯            ○ ◯              ○                              │
│  (bubbles are styles: colour = category, size = sales so far, height = sell-through) │
└────────────────────────────────────────────────────────────────────────────────────┘
┌ Size availability: category × size, % of stores with it on the floor ┐ ┌ Sell-through vs. weeks of cover ┐
┌ Season buy · allocation [flat | by store's size mix] · replenishment lead time · markdown rule ┐
┌ Styles: price, cost, current price, sold, on hand, sell-through, lost to size stockouts ┐
```

This is the supply-chain half, and the reason sizes matter.

- **Products.** Each brand carries a catalogue of styles: category, basic or
  trend, full price, cost and a size run (XS–XL). Brands differ in price
  position and breadth. For example, the value brand is cheap and narrow,
  and the premium brand is dear and deep.
- **Stock**
  - A season's buy sits at a distribution centre.
  - Stores get an opening allocation, then weekly replenishment after a lead
    time.
  - In each store, stock is split between the floor and the stockroom. The
    floor is refilled each morning.
- **Allocation policy.** A flat size split, or each store's own size mix
  learned from its sales. This is the classic fashion supply-chain lever,
  and it feeds straight into the funnel's "not in my size" losses.
- **Markdown rule.** A weekly review marks a style down by a set step when
  its sell-through is behind target, with clearance in the last weeks of the
  season. This is the pipeline's "kill if ROI is below" rule, recast for
  fashion.

### 3.5 Scorecard

- **Visits:** satisfied vs. not, and why visits failed, by reason.
- **Time in store:** a histogram with count, mean, minimum, maximum and
  standard deviation, as in the Statistics picture.
- **Staff utilisation** over time, by role.
- **Size fill rate:** how often a shopper's requested size was found.
- **Contribution waterfall:** sales − markdowns − cost of goods − staff
  cost = contribution, by brand.
- **Export:** a CSV of the season's daily results.

---

## 4. The model

### 4.1 Agents

| Agent | What it holds | What it does |
|---|---|---|
| **Brand** (four: ours and three rivals) | Price position, strategy levers (section 3.1), colour, catalogue | Sets prices, promotions, markdowns and staffing for its stores |
| **Store** | Brand, metro, format, stock by style and size (floor and stockroom), fitting rooms, tills, staff | Opens and closes; refills the floor; places replenishment orders |
| **Household or shopper** | Metro and home, segment, apparel budget for the season and what's left of it, price sensitivity, style taste, size, appeal of each brand, memory of recent visits | Decides whether to shop, where, and what to buy; tells others about good and bad visits |
| **Cashier** | Till, scan speed, busy until | Serves the till queue one shopper at a time |
| **Sales assistant** (optional per brand) | Zone, skill, busy until | Advises shoppers, which raises the chance of a try-on. Fetches a missing size from the stockroom, which takes the assistant's time |

**Shopper segments** (illustrative, each a set of parameters): value
seekers, trend followers, quality loyalists and convenience shoppers.

**Scale.** Each household dot stands for many real households. The
dollars are scaled to match, and the page says so.

### 4.2 A shopper's trip

1. **Need.** Each day, a household goes shopping with a probability that
   depends on its segment, how much budget it has left, the time in the
   season, and any promotion it has heard of.
2. **Where.** A multinomial logit over the stores in its metro, plus the
   option of staying home. The same method as the digital twin preset. A
   store's appeal adds up:
   - the household's own taste for the brand (a random draw kept for the
     season)
   - price position times the household's price sensitivity
   - promotion
   - distance
   - memory of bad visits there (a stockout, a long queue, a walk-out)
   - word of mouth
3. **Browse.** The shopper walks to the category zones their segment favours
   and chooses styles from what's on the rack **in their size**. That choice
   is also a logit: style fit, price against a reference price (markdowns
   attract), and budget. If the size is missing, an assistant may fetch it
   from the stockroom, if one is free and the stockroom has it.
4. **Try on.** They join the fitting-room queue, or leave it if it's longer
   than they'll tolerate. Each item takes time to try on, and there's a
   chance it fits and pleases.
5. **Pay.** They join the till queue, or walk out if it's too long. The
   cashier scans each item.
6. **After.** The visit's outcome updates the household's memory of the
   brand and store, its budget, and the tallies behind every chart. Word of
   mouth passes some of that to other households in the same metro.

Every loss in the Funnel tab is one of these steps going wrong for one
agent, recorded with its reason at the moment it happens.

### 4.3 Money

- **Sales** at the current price, after markdowns and promotions.
- **Cost of goods** from the style's cost.
- **Markdown cost:** full price minus the price paid.
- **Staff cost:** hours times the wage.

Contribution is what's left after these. Rent and overheads are left out
(stated on the page).

### 4.4 Time: one clock for walking and for a season

This is the hardest design problem.

- A shopper spends 10–40 minutes in a store and a few seconds walking
  between racks. A season lasts 13 weeks.
- A fixed time step small enough to show walking makes a season far too
  slow. A step big enough for a season hides the walking.

**The design:**

- **Every activity gets an exact start and end time when it begins:** walk
  to denim, browse, queue, try on, pay.
- **The simulation advances in short fixed steps** (around 30 s of store
  time). Within each step, it handles everything that ends in time order:
  who took the last size M first, and who joined the queue first.
- **What you see is drawn from those exact times, at whatever pace you
  watch.** A shopper's position is placed along their route by the clock,
  and so is a queue's length. The store view can show 5-second frames, and
  the market map one frame per day.

**What this guarantees:**

- **The results are the same whether you watch a store or run the season at
  full speed.** Watching changes only what's drawn. A test checks this
  (section 6.3).
- **A change made mid-day acts from that moment.** For example, adding a
  cashier at 14:00 shortens the queue from 14:00.

**The target, measured before building anything else (milestone 0):**

| | |
|---|---|
| Scale | 4 metros, about 16 stores, about 8,000 household agents, several thousand store visits a day, several hundred shoppers in stores at once |
| A full market day | ≤ 0.5 s in webR, so a season takes under a minute at full speed |
| Watching a store | at least 30 frames a second, while the whole market keeps running |

If the measurement misses the target, the fix is less scale (fewer
households or stores) or a shorter season. I'll report the measured numbers
as they are.

### 4.5 Geography

**Recommendation: four real metros side by side on one map.**

- **Where people live:** US Census block-group population centres. These are
  public files with no sign-up. **Verified today:** Indiana's file is at
  `www2.census.gov/geo/docs/reference/cenpop2020/blkgrp/CenPop2020_Mean_BG18.txt`.
  It gives population, latitude and longitude for each block group.
- **Where stores are:** real clothing-store and shopping-mall sites from
  OpenStreetMap. **Verified today:** 90 `shop=clothes` and `shop=mall`
  features in the Indianapolis box the other presets use.
- **Brands:** invented names, placed on those real sites. No real brand
  names or logos.
- **Travel cost:** from straight-line distance, stated as such on the page.
  This means no road networks to build for four cities.
- Indianapolis is the natural anchor, since the other presets already use
  it. The other three are your choice (section 9). I'll check each one's
  data before building on it.

The alternatives:

- **Several shopping districts within Indianapolis.** This reuses the baked
  road network, but it's one geography rather than several.
- **Stylised regions**, like the consumer-market picture. This is quickest,
  but it isn't real.

### 4.6 Data and honesty rules

- **No gated or licensed data.** Everything real comes from OpenStreetMap
  (ODbL) or the Census Bureau, both public with no sign-up. I check every
  source before any work depends on it, as I did for the two sources above.
- **Every behaviour is either a slider or a named constant with a comment.**
  The page says the brands, shoppers and dollars are illustrative. I won't
  quote industry figures I haven't verified.

---

## 5. What stays the same

- **The Workbench model:** the interface language plus one R model file, run
  in webR with NetLogoR.
  - The fashion project is written the same way as the other presets. It
    has an interface text and a model file.
  - The model file is split into clear sections: market, store, stock,
    staff, charts.
  - If the model grows past about 2,000 lines, we'll discuss splitting it
    into several files then. That would be an engine change.
- **Existing presets** keep working unchanged (section 9 asks about the
  default).
- **Existing features stay:** the parser, layout grid, binary frame
  protocol, recorder, share links, imports and downloads.

---

## 6. The application changes this project needs

Each of these is a general Workbench feature, documented and tested, not a
fashion-specific hack. Each one exists because the project can't be built
without it.

### 6.1 Interface language and engine

1. **Tabs.**

   ```text
   panel run "Run"            # lines before the first tab: the header, on every tab
     button setup
     button go forever .right()
   end

   tab market "Market"
     view map "The market" world market_map turtles households w 12 h 9 click { select_store(x, y) }
     ...
   end

   tab store "Store"
     ...
   end
   ```

   - Each tab lays out on its own grid. Placing a widget relative to a
     widget in another tab is an error.
   - **Only what's on screen is drawn.** Views on hidden tabs aren't packed
     into frames, and their plots, reports and monitors don't redraw.
     Switching tabs brings them up to date at once. Without this, the market
     map's thousands of dots and the floor plan would be redrawn even while
     out of sight.
2. **Clicks on views.**
   - A `view` can carry `click { R code }`. The code runs with `x` and `y`,
     the clicked point in world coordinates, like a button.
   - This drives "click a store to open it" and "click a shopper to follow
     them".
3. **Switching tabs from R.** `show_tab("store")`, so a click on the market
   map can open the Store tab.
4. **Text labels on the world**, as NetLogo's turtle `label` does.
   - Set with `turtlesOwn(turtles, tVar = "label", tVal = "Denim")`.
   - Used for zone names on the floor plan, and for metro and store names
     on the map.
   - The frame protocol carries a table of label strings that's sent only
     when it changes, the same way colour tables are sent today.

### 6.2 Application code

- **`js/main.js`** (926 lines) is split along seams it already has: the
  engine session, the gallery and workspace, the run controls, and the new
  tab handling. It already holds too many concerns, and tabs would add
  another.
- **Widgets, layout, views, the worker and `r/workbench.R`** change where
  tabs, visibility, clicks and labels need them, and nowhere else.

### 6.3 Tests

- **Parser and layout:** tabs, the header, cross-tab placement errors, and
  `click` syntax and its errors.
- **Frames:** labels, and only visible views being packed.
- **Engine** (`tools/test-engine.R`): clicks, `show_tab`, and visibility.
- **The fashion model, run headless** in `tools/check-templates.R`, with
  checks that must always hold:
  - Every visit ends in exactly one funnel outcome.
  - Units bought = sold + on floor + in stockroom + in transit + at the DC.
  - Sales = the sum of receipts.
  - No cashier serves two shoppers at once.
  - No wait is negative.
  - **The same seed gives the same season whether it's run at *season* pace
    or at *watch* pace.** This is the test that the store view is the real
    simulation.

---

## 7. Portfolio polish and packaging

- **Look**
  - A tab bar in the spirit of the reference images.
  - A compact header.
  - **One chart style for every chart:** donut, stacked area, bars, funnel,
    flow diagram and lifecycle bubbles, all drawn by a small set of R
    chart helpers in the model.
  - **One brand palette, defined once in R**, so a brand is the same colour
    on the map, the floor, the funnel and every chart.
  - I'll check every chart in light and dark mode.
- **First visit.** If you agree, the app opens on the fashion project with
  the code drawer closed. **Edit** shows the code. Today the drawer opens
  on screens 1400 px or wider, so this changes current behaviour.
- **README as a case study:**
  - the business questions
  - the method (shopper choice, in-store queues, stock and markdown, and the
    time design)
  - the architecture diagram
  - screenshots
  - how to run it
  - what's real and what's illustrative
  - the tests
- **Hosting.** It's still static files, so GitHub Pages works. The GitHub
  account signed in on this Mac isn't yours, so nothing gets published until
  you choose the account.

---

## 8. Build order

Each milestone ends with a working app and a short check-in with you before
the next one starts.

| # | Milestone | Done when |
|---|---|---|
| 0 | **Speed test.** A bare-bones version of the store and market simulation, measured in webR | Numbers against the targets in 4.4, reported as measured |
| 1 | **Engine features:** tabs, the header, drawing only what's visible, view clicks, `show_tab`, labels | Tests pass; the existing presets are unchanged |
| 2 | **One store, end to end:** a floor plan, shoppers, fitting rooms, cashiers, assistants, and the Store tab (floor, heat, flow, KPIs, follow a shopper) | You can watch a store's day, and its numbers add up |
| 3 | **The fleet and the market:** brands, metros, stores, households, store choice, strategy levers, the Market tab, and clicking through to a store | A season runs, and shares respond to the levers |
| 4 | **Products and stock:** catalogues, sizes, allocation, replenishment, markdown, and the Assortment tab | Size stockouts show in the funnel's losses |
| 5 | **The Funnel and Scorecard tabs**, and CSV export | The 60-second tour in section 1 works |
| 6 | **Polish and packaging:** chart style, the first visit, the README case study, screenshots, and the full test pass | Ready to show |

---

## 9. Decisions I need from you

1. **Geography.** My recommendation is four real metros (section 4.5).
   Which three besides Indianapolis? Or would you rather have Indianapolis
   districts, or stylised regions?
2. **Brands.** I suggest four: ours as the mid-market brand, plus a value
   brand, a premium brand and a fast-fashion rival. Do you want a different
   number, or a different position for "ours"?
3. **Default project.** Should the fashion project open by default, with
   the other presets (zombies, promotion vs. supply chain, digital twin,
   blank) staying in the menu?
4. **First visit.** Should the code drawer start closed (section 7)?
5. **Housekeeping before anything is public.** Deleting any of these is
   your call:
   - `templates/data/retail-louisville.rds` contains dunnhumby store data
     you never agreed to. It must not be published.
   - `tools/retail/` (six scripts) and `PLAN-retail-market.md` belong to
     the abandoned retail plan.
   - `templates/monorail.ui` has no model and isn't in the menu. The README
     cites it as a layout example.
6. **Version control.** The project folder isn't a git repository. For a
   portfolio, its history is worth keeping from here on. Should I set one
   up?
7. **Name.** Should it stay "NetLogoR Workbench", or should the portfolio
   piece have a name of its own?

---

## 10. Deliberately left out

- **3D camera views.** The renderer is 2D.
- **Online sales and returns.** The point is shoppers in stores.
- **Real brand names or logos,** and any gated or licensed data.
- **Scenario presets, new toolbar buttons, or a JavaScript charting
  library.** Charts stay in R, as the Workbench's plots already are.
- **A server or backend.** It stays static files, running entirely in the
  browser.
