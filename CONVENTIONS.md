# Porting conventions — Python → Node.js (READ BEFORE WRITING ANY FILE)

Source (read-only): `~/workspace/mcp-pt-inspect/src/packet_tracer_mcp/`
Target: `~/workspace/packet-tracer-mcp-node/src/` — mirror the Python layout
(`domain/models/x.py` → `src/domain/models/x.js`, etc.).

This is a FIDELITY port. The Python file is the spec: read it fully, then write
the JS that behaves identically. Do not invent behaviour. Where Python is
unclear, match the code, not your guess.

## Language / style

- ESM only (`import`/`export`), Node >= 20, NO external dependencies.
- Keep Python names: functions/variables in `snake_case`, classes in
  `CamelCase`, constants in `UPPER_SNAKE`. File names identical to Python.
- Keep the Python comments/docstrings (as JS comments) — they carry measured
  PT facts. Keep all string literals byte-identical, including error messages.
- Every file must pass `node --check <file>`.

## Models (pydantic → JS)

- A pydantic model becomes a JS class: `constructor(obj = {})` assigning each
  field in DECLARATION ORDER, applying the Python default when the key is
  absent/undefined. Mutable defaults (list/dict) must be copied per instance.
- `model_dump()` → method `toDict()` returning a plain object with keys in
  declaration order (nested models → nested toDict(), enums → their string).
- Python enums are string enums; `src/shared/enums.js` exports frozen maps
  name→value and the values ARE the strings. A model field holding an enum
  holds the plain string in JS.
- Nested model fields: wrap plain objects into the model class in the
  constructor (pydantic does this). Optional fields default to `null`
  (Python `None`).
- `field(default_factory=...)` → call the factory per instance.
- Basic pydantic coercion: numeric strings for int/float fields are coerced
  (`int("5")` works in pydantic lax mode); bool fields accept booleans only.
  Apply where the Python model declares the type and the input may be raw.

## Python semantics — use `src/shared/pycompat.js`

- `json.dumps(x)` → `pyJsonDumps(x)` (default: ensure_ascii, `', '`/`': '`
  separators). Compact dumps with `separators=(",", ":")` →
  `pyJsonDumps(x, {separators: [",", ":"]})`. `ensure_ascii=False` →
  `{ensureAscii: false}`. `indent=2` → `{indent: 2}`. `sort_keys=True` →
  `{sortKeys: true}`.
- `to_json`/`reply_json` from `shared/utils.js` for tool replies.
- `str(x)` → `pyStr(x)`, `repr(x)` → `pyRepr(x)`, `round(x, n)` →
  `pyRound(x, n)` (returns PyFloat, serializes like a Python float),
  `round(x)` → `pyRound(x)` (int).
- Truthiness: Python treats `""`, `[]`, `{}`, `0` as falsy; JS doesn't for
  `[]`/`{}`. Where Python code branches on a collection/string value, use
  `pyTruthy(v)`. For plain `if x is not None` checks use `x !== null && x !== undefined`.
- `a // b` → `pyFloorDiv`, `%` on possibly-negative → `pyMod`.
- Sorting: Python `sorted(xs)` on strings = code-point order. Use
  `[...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))`; `sorted(xs, key=f)`
  → sort by computed key with the same comparator. NEVER use bare `.sort()`
  on numbers (JS sorts them as strings) — numeric comparator `(a,b)=>a-b`.
- Dict iteration order = insertion order in both languages, BUT JS objects
  reorder INTEGER-LIKE keys numerically. Python dicts with int keys or
  numeric-string keys that are iterated for output: use a `Map` or an array
  of [key, value] pairs instead. (Check each site; most are fine.)
- `ipaddress` → `src/shared/ipnet.js` (`IPv4Network`, `IPv4Address`,
  `IPv6Network`, `IPv6Address`, `ip_network`, `ip_address`, `ip_interface`).
  `str(net)` gives "a.b.c.d/p"; `.network_address` etc. return address
  objects — call `.toString()` where Python would stringify.
- Exceptions: Python `ValueError(msg)` → `throw new Error(msg)` with the SAME
  message. `KeyError(k)` messages differ — only surface them if the Python
  code surfaces them.
- String ops: Python `s.strip()` ≈ `.trim()`; `sep.join(list)` →
  `list.join(sep)`; `s.split()` (whitespace, no empties) →
  `s.trim().split(/\s+/).filter(Boolean)` (careful: `"".split()` → `[]`);
  `s.partition(sep)` → manual indexOf; f-strings → template literals
  (numbers: use pyStr/pyFloatRepr where Python would print a float).
- Regex: Python `re` ≈ JS RegExp; `\d`, `\s`, `\w` same. `re.fullmatch` →
  wrap with ^...$. Named groups differ — rewrite as positional.
- `time.sleep` in synchronous Python logic: the port makes such functions
  `async` and uses `await sleep(ms)` from pycompat. Pure string builders
  stay synchronous.
- File IO: Python pathlib sync code → `node:fs` sync APIs + `node:path`.
  Python `Path.write_text(..., encoding="utf-8")` → `fs.writeFileSync(p, s, "utf-8")`.
- `os.environ.get("X")` → `process.env.X`. `os.name == "nt"` →
  `process.platform === "win32"`. `Path.home()` → `os.homedir()`.
- hashlib.sha256 → `crypto.createHash("sha256")`.

## Already ported (import from these, do not re-create)

- `src/shared/pycompat.js`: pyJsonDumps, pyFloatRepr, PyFloat, pyRound,
  pyTruthy, pyStr, pyRepr, pyFloorDiv, pyMod, ipToInt, intToIp, sleep, monotonic.
- `src/shared/constants.js`, `src/shared/enums.js`, `src/shared/utils.js`,
  `src/shared/ui_mode.js` (UiModeStore is async: get/set/should_show return Promises),
  `src/shared/ipnet.js`.
- `src/settings.js`: SERVER_NAME, GUIDE, SERVER_INSTRUCTIONS.
- `src/infrastructure/execution/bridge_token.js`, `live_bridge.js`
  (PTCommandBridge; drain_commands/take_result are async), `file_bridge.js`
  (FileBridge; send_and_wait async).
- `src/adapters/mcp/bridge_context.js`: BridgeContext — ALL methods async
  (send_and_wait, check_bridge, ensure_bridge, pick_channel, channel_send,
  send_payload, read_live_devices, live_devices, fast_forward, settle_stp,
  canvas_size, http_get, http_post return Promises). DEPLOY_BATCH, TIMEOUT_MSG,
  LIVE_DEVICES_JS, STP_SETTLE_S, creates_links, stp_wait_seconds.

## Tool modules (adapters/mcp/tools/*.js)

- Export `export async function register(registry, ctx)`.
- Register handlers: `registry.tool("pt_xxx", async (args) => { ... })`.
- `args` is a plain object keyed by the PYTHON parameter names. Apply the
  Python defaults when a key is `undefined`. Tool names/params/descriptions
  are NOT defined here (they live in tool_defs.json) — read the Python
  function signature for exact parameter names and defaults.
- Handlers return what Python returns (usually a string via reply_json /
  to_json / plain text). Python bools in dicts → JS true/false; Python None → null.
- ValueError raised by use cases: Python FastMCP surfaces it as a tool error;
  in JS just let it throw (the server shell wraps errors).
- `ctx` is the BridgeContext (async methods — await them).

## Platform gating (Windows-only UI automation)

- infrastructure/ui/win32.js and uia.js: port the logic, but any function that
  would touch Win32/UIA must, when `process.platform !== "win32"`, throw or
  return the module's documented platform error. Read how the Python original
  behaves off-Windows (presenter.py) and mirror its message; never fake success.

## Reporting

Report back: files written, what is fully ported vs partial/stubbed (and why),
and the output of `node --check` on your files. Honesty over completeness claims.
