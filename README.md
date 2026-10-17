# botguard-rs

Runs YouTube's BotGuard challenge in QuickJS (`rquickjs`) and mints WebPO (PO) tokens
in-process. No browser, Node or jsdom at runtime.

```rust
let bg = botguard::BotGuard::new();
let challenge = botguard::Challenge::parse(&bg_challenge_json)?;
let interpreter = http_get(&challenge.interpreter_url)?;            // caller does the I/O
let snapshot = bg.snapshot(interpreter, challenge, Some(ytcfg_json))?;
let it = botguard::parse_generate_it(&http_post(botguard::GENERATE_IT_URL,
    botguard::GENERATE_IT_HEADERS, botguard::generate_it_request(&snapshot))?)?;
bg.install(it.token)?;                                               // valid for it.ttl
let po_token = bg.mint(video_id.into())?;                            // ~ms per binding
```

The challenge must be the page's own `bgChallenge` and `ytcfg` (the attestation is bound
to the page's `EVENT_ID`).

## How the environment is built

- `src/dom-shape.json` is jsdom's DOM surface (interfaces, members, default values), made
  by `scripts/gen-dom-shape.mjs`; `src/dom.js` turns it into classes.
- `src/probe.js` builds the global scope as a bgutil process has it: Node 24's globals in
  Node's order, then `window`, `document`, `location`, `origin`. The VM enumerates the
  global object, so its name list is part of the fingerprint.

## Dev tool (`--features cli`)

```sh
botguard-rs probe <dir>   # log every property the VM reads (dir: challenge.json, interpreter.js[, ytcfg.json])
botguard-rs it <dir>      # snapshot + GenerateIT; BG_MINT=<id> also mints
botguard-rs serve [port]  # bgutil-compatible POST /get_pot, GET /ping
```

`scripts/jsdom-oracle.mjs` runs a challenge the bgutil way for comparison.

MIT, see [`LICENSE`](LICENSE). `src/dom-shape.json` is derived from jsdom (MIT, see
[`LICENSE-jsdom`](LICENSE-jsdom)).

This is an unofficial tool. It is not affiliated with, endorsed by or supported by YouTube
or Google.
