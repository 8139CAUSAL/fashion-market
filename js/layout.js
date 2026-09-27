// Turns the interface spec's relative placements into grid cells.
//
// Widgets say where they sit relative to each other (.right(x), .under(x),
// .left(x), .above(x), or the bare forms relative to the previous line);
// this resolves that into rows and columns of fixed-size cells.
//
//   - a widget with no placement starts a new row at the left edge
//   - .right(x) puts it beside x, .under(x) below x, and so on, offset by
//     any padding
//   - if the chosen cells are taken, it slides along until they are free,
//     so widgets can never overlap
//   - a panel's widgets are laid out on their own first; the panel is then
//     placed as one block, like a widget
//
// Everything ends up on one page-wide grid, so rows line up across panels
// side by side. gridTracks() turns the cells into CSS grid tracks.

export class LayoutError extends Error {
  constructor(message, line) {
    super(message);
    this.name = "LayoutError";
    this.line = line;
  }
}

const SLIDE = { right: "right", under: "down", left: "left", above: "up" };

// `items` is parseSpec()'s list: widgets, panels and gaps. Problems throw a
// LayoutError, unless `onError` is given: then each is reported and the
// placement it concerns is ignored, so a half-finished spec still lays out.
export function resolveLayout(items, { onError } = {}) {
  const report = (message, line) => {
    const err = new LayoutError(message, line);
    if (!onError) throw err;
    onError(err);
  };

  const panels = items.filter((item) => item.type === "panel");
  const panelById = new Map(panels.map((panel) => [panel.id, panel]));
  const home = new Map();
  for (const item of items) if (item.name && !item.gap && !home.has(item.name)) home.set(item.name, item.panel);

  const unknownTarget = (item, target, scope) => {
    if (!home.has(target)) return `"${describe(item)}" is placed relative to "${target}", which does not exist.`;
    const where = home.get(target);
    if (scope) {
      return where === null
        ? `"${describe(item)}" is in panel "${scope.name}" but is placed relative to "${target}", which isn't. Widgets are placed within their own panel.`
        : `"${describe(item)}" is placed relative to "${target}", which is in panel "${panelById.get(where).name}". Widgets are placed within their own panel.`;
    }
    return `"${describe(item)}" is placed relative to "${target}", which is inside panel "${panelById.get(where).name}". Place it relative to the panel instead.`;
  };

  // Each panel's contents first, in the panel's own cells...
  const size = new Map(items.map((item) => [item.id, { cols: item.cols, rows: item.rows }]));
  const local = new Map();
  for (const panel of panels) {
    const children = items.filter((item) => item.panel === panel.id);
    const scope = placeScope(children, panel, size, report, unknownTarget);
    for (const [id, position] of scope.positions) local.set(id, position);
    size.set(panel.id, { cols: Math.max(1, scope.cols), rows: Math.max(1, scope.rows) });
  }

  // ...then the top level, where each panel is one block.
  const top = placeScope(items.filter((item) => item.panel === null), null, size, report, unknownTarget);

  const positioned = items.map((item) => {
    const own = item.panel === null ? top.positions.get(item.id) : local.get(item.id);
    const panel = item.panel === null ? null : top.positions.get(item.panel);
    return {
      ...item,
      ...size.get(item.id),
      row: panel ? panel.row + own.row - 1 : own.row,
      col: panel ? panel.col + own.col - 1 : own.col,
    };
  });

  // Reading order, which is also the order the widgets appear in the DOM.
  const readingOrder = (a, b) => a.row - b.row || a.col - b.col;
  const widgets = positioned.filter((item) => item.type !== "panel" && !item.gap).sort(readingOrder);
  const shownPanels = positioned.filter((item) => item.type === "panel" && !item.gap).sort(readingOrder);
  const gaps = positioned.filter((item) => item.gap && item.type !== "panel").sort(readingOrder);

  return {
    widgets,
    panels: shownPanels,
    gaps,
    columns: Math.max(1, top.cols),
    rows: Math.max(1, top.rows),
  };
}

const describe = (item) => item.name ?? `${item.type} on line ${item.line}`;

// Places one scope's items (a panel's contents, or the top level) in cells
// starting at row 1, column 1.
function placeScope(list, panel, size, report, unknownTarget) {
  const byId = new Map(list.map((item) => [item.id, item]));
  const byName = new Map();
  // Real widgets first; a gap answers to its name only if nothing else does.
  for (const item of list) if (item.name && !item.gap && !byName.has(item.name)) byName.set(item.name, item);
  for (const item of list) if (item.name && item.gap && !byName.has(item.name)) byName.set(item.name, item);

  const positions = new Map();
  const occupied = new Set();
  const key = (row, col) => `${row}:${col}`;
  let leftEdge = 1;

  const cells = (position, { cols, rows }, visit) => {
    for (let r = position.row; r < position.row + rows; r++) {
      for (let c = position.col; c < position.col + cols; c++) {
        if (visit(key(r, c)) === false) return false;
      }
    }
    return true;
  };

  const place = (item, resolving = []) => {
    if (positions.has(item.id)) return positions.get(item.id);

    if (resolving.includes(item.id)) {
      const cycle = [...resolving.slice(resolving.indexOf(item.id)), item.id].map((id) => describe(byId.get(id)));
      report(`Widgets are placed in a circle: ${cycle.join(" → ")}.`, item.line);
      return null;
    }

    const own = size.get(item.id);
    let position = null;
    let slide = "down";

    for (const relation of item.relations) {
      let target = null;
      if (relation.target !== null) {
        target = byName.get(relation.target);
        if (!target) {
          report(unknownTarget(item, relation.target, panel), item.line);
          continue;
        }
      } else if (relation.ref !== null && relation.ref !== undefined) {
        target = byId.get(relation.ref);
      }

      slide = SLIDE[relation.kind];

      // A bare placement on a scope's first line starts at its top-left.
      if (!target) {
        const across = relation.kind === "right" || relation.kind === "left";
        position = { row: across ? 1 : 1 + relation.gap, col: across ? 1 + relation.gap : 1 };
        continue;
      }

      const anchor = place(target, [...resolving, item.id]);
      if (!anchor) continue;
      const other = size.get(target.id);
      switch (relation.kind) {
        case "right": position = { row: anchor.row, col: anchor.col + other.cols + relation.gap }; break;
        case "left": position = { row: anchor.row, col: anchor.col - own.cols - relation.gap }; break;
        case "under": position = { row: anchor.row + other.rows + relation.gap, col: anchor.col }; break;
        case "above": position = { row: anchor.row - own.rows - relation.gap, col: anchor.col }; break;
      }
    }

    // No placement: begin a fresh row at the left edge, below the widget
    // before it, so a plain list of widgets reads top to bottom.
    if (!position) {
      const previous = previousPlaced(list, item, positions);
      position = { row: previous ? previous.position.row + size.get(previous.item.id).rows : 1, col: leftEdge };
      slide = "down";
    }

    // Keep sliding until the cells are free: two widgets anchored to the
    // same neighbour stack instead of landing on top of each other.
    while (!cells(position, own, (cell) => !occupied.has(cell))) {
      if (slide === "right") position.col += 1;
      else if (slide === "left") position.col -= 1;
      else if (slide === "up") position.row -= 1;
      else position.row += 1;
    }

    cells(position, own, (cell) => { occupied.add(cell); });
    positions.set(item.id, position);
    leftEdge = Math.min(leftEdge, position.col);
    return position;
  };

  for (const item of list) place(item);

  // Placing things left of or above the first widget can reach column or
  // row 0 and below; shift everything so the scope starts at 1.
  const minRow = Math.min(1, ...[...positions.values()].map((p) => p.row));
  const minCol = Math.min(1, ...[...positions.values()].map((p) => p.col));
  let cols = 0;
  let rows = 0;
  for (const [id, position] of positions) {
    position.row += 1 - minRow;
    position.col += 1 - minCol;
    cols = Math.max(cols, position.col + size.get(id).cols - 1);
    rows = Math.max(rows, position.row + size.get(id).rows - 1);
  }

  return { positions, cols, rows };
}

// The most recently placed item in spec order, used as the default anchor.
function previousPlaced(list, item, positions) {
  for (let i = list.indexOf(item) - 1; i >= 0; i--) {
    const candidate = list[i];
    if (positions.has(candidate.id)) return { item: candidate, position: positions.get(candidate.id) };
  }
  return null;
}

// ---- CSS grid tracks ----------------------------------------------------

// Every cell is one fixed-size track (sizes come from CSS variables). Where a
// panel directly touches a neighbour, a gutter track runs across the whole
// page between them, so panel frames never touch what's beside them and rows
// and columns still line up everywhere.
//
// Returns the track lists and area(item), the CSS grid lines an item spans.
// For a widget inside a panel (a subgrid), pass the panel as `within`.
export function gridTracks(layout) {
  const owner = new Map();
  const blocks = [...layout.panels, ...layout.widgets.filter((widget) => widget.panel === null)];
  for (const block of blocks) {
    for (let r = block.row; r < block.row + block.rows; r++) {
      for (let c = block.col; c < block.col + block.cols; c++) owner.set(`${r}:${c}`, block.id);
    }
  }
  const touches = (panel, cells) => cells.some(([r, c]) => {
    const other = owner.get(`${r}:${c}`);
    return other !== undefined && other !== panel.id;
  });
  const range = (start, count) => Array.from({ length: count }, (_, i) => start + i);

  const colGutters = new Set();
  const rowGutters = new Set();
  for (const panel of layout.panels) {
    const rows = range(panel.row, panel.rows);
    const cols = range(panel.col, panel.cols);
    const right = panel.col + panel.cols;
    const below = panel.row + panel.rows;
    if (touches(panel, rows.map((r) => [r, right]))) colGutters.add(right - 1);
    if (touches(panel, rows.map((r) => [r, panel.col - 1]))) colGutters.add(panel.col - 1);
    if (touches(panel, cols.map((c) => [below, c]))) rowGutters.add(below - 1);
    if (touches(panel, cols.map((c) => [panel.row - 1, c]))) rowGutters.add(panel.row - 1);
  }

  const axis = (count, gutters, track) => {
    const start = [];
    const tracks = [];
    for (let k = 1; k <= count; k++) {
      start[k] = tracks.length + 1;
      tracks.push(track);
      if (gutters.has(k)) tracks.push("var(--gutter)");
    }
    return { start, template: tracks.join(" ") };
  };

  const columns = axis(layout.columns, colGutters, "var(--cell-w)");
  const rows = axis(layout.rows, rowGutters, "minmax(var(--cell-h), auto)");

  const span = (starts, first, count, offset) =>
    `${starts[first] - offset} / ${starts[first + count - 1] + 1 - offset}`;

  return {
    columns: columns.template,
    rows: rows.template,
    area(item, within = null) {
      const rowOffset = within ? rows.start[within.row] - 1 : 0;
      const colOffset = within ? columns.start[within.col] - 1 : 0;
      return {
        row: span(rows.start, item.row, item.rows, rowOffset),
        column: span(columns.start, item.col, item.cols, colOffset),
      };
    },
  };
}
