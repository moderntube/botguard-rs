use rquickjs::context::EvalOptions;
use rquickjs::function::IntoArgs;
use rquickjs::{CatchResultExt, Context, Function, Object, Persistent, Runtime};
use std::time::{Duration, Instant};

const ENV: &str = include_str!("probe.js");
const DOM: &str = include_str!("dom.js");
const SHAPE: &str = include_str!("dom-shape.json");

/// One BotGuard VM in its own QuickJS runtime, driven stage by stage from the host loop.
/// The environment's control functions live on `api`, held here and absent from the global.
pub struct Vm {
    api: Persistent<Object<'static>>,
    ctx: Context,
    rt: Runtime,
}

fn sloppy() -> EvalOptions {
    let mut opts = EvalOptions::default();
    opts.strict = false;
    opts
}

impl Vm {
    pub fn new(probe: bool, yt_config: Option<&str>) -> Result<Self, String> {
        let rt = Runtime::new().map_err(|e| e.to_string())?;
        let ctx = Context::full(&rt).map_err(|e| e.to_string())?;
        let api = ctx.with(|ctx| {
            let cfg = Object::new(ctx.clone()).map_err(|e| e.to_string())?;
            cfg.set("probe", probe).map_err(|e| e.to_string())?;
            cfg.set("nav", std::env::var("BG_NAV").unwrap_or_default()).map_err(|e| e.to_string())?;
            if let Some(c) = yt_config {
                cfg.set("ytConfig", c).map_err(|e| e.to_string())?;
            }
            let shape: rquickjs::Value = ctx.json_parse(SHAPE).map_err(|e| e.to_string())?;
            cfg.set("shape", shape).map_err(|e| e.to_string())?;
            ctx.globals().set("__BG", cfg).map_err(|e| e.to_string())?;
            ctx.eval_with_options::<(), _>(DOM, sloppy()).catch(&ctx).map_err(|e| e.to_string())?;
            let api: Object = ctx.eval_with_options(ENV, sloppy()).catch(&ctx).map_err(|e| e.to_string())?;
            Ok::<_, String>(Persistent::save(&ctx, api))
        })?;
        Ok(Self { rt, ctx, api })
    }

    pub fn call<A: for<'js> IntoArgs<'js>>(&self, name: &str, args: A) -> Result<(), String> {
        self.ctx.with(|ctx| {
            let api = self.api.clone().restore(&ctx).map_err(|e| e.to_string())?;
            let f: Function = api.get(name).map_err(|e| format!("{name}: {e}"))?;
            f.call::<_, ()>(args).catch(&ctx).map_err(|e| format!("{name}: {e}"))
        })
    }

    pub fn state(&self, key: &str) -> Option<String> {
        self.ctx.with(|ctx| {
            let api = self.api.clone().restore(&ctx).ok()?;
            let s: Object = api.get("state").ok()?;
            s.get::<_, Option<String>>(key).ok().flatten()
        })
    }

    pub fn log(&self) -> String {
        self.ctx.with(|ctx| {
            let Ok(api) = self.api.clone().restore(&ctx) else { return String::new() };
            api.get::<_, Function>("log").and_then(|f| f.call(())).unwrap_or_default()
        })
    }

    /// Run jobs and timers until `state.stage == until`, or `limit` passes.
    pub fn pump(&self, limit: Duration, until: &str) -> Result<(), String> {
        let end = Instant::now() + limit;
        loop {
            while self.rt.is_job_pending() {
                let _ = self.rt.execute_pending_job();
            }
            self.call("tick", ())?;
            if self.state("stage").as_deref() == Some(until) {
                return Ok(());
            }
            if Instant::now() >= end {
                return Err(format!("timed out waiting for {until} (stage {:?})", self.state("stage")));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Load the interpreter, start the program, and take the attestation snapshot.
    pub fn snapshot(&self, interpreter: &str, program: &str, global_name: &str) -> Result<String, String> {
        self.call("load", (interpreter,))?;
        self.call("start", (program, global_name))?;
        self.pump(Duration::from_secs(5), "fns")?;
        self.call("snapshot", ())?;
        self.pump(Duration::from_secs(5), "done")?;
        self.state("snapshot").ok_or_else(|| "no snapshot".into())
    }

    pub fn minter(&self, integrity_token: &str) -> Result<(), String> {
        self.call("minter", (integrity_token,))?;
        self.pump(Duration::from_secs(5), "minter-ready")?;
        match self.state("error") {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    pub fn mint(&self, identifier: &str) -> Result<String, String> {
        self.call("mint", (identifier,))?;
        self.pump(Duration::from_secs(5), "minted")?;
        if let Some(e) = self.state("error") {
            return Err(e);
        }
        self.state("pot").ok_or_else(|| "no token".into())
    }
}
