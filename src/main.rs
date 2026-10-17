//! BotGuard in QuickJS.
//!
//!   botguard-rs probe <fixtures-dir>   log the browser surface a challenge reads
//!   botguard-rs serve [port]           bgutil-compatible POST /get_pot + GET /ping

use botguard::Vm;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

const USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("probe") => probe(args.get(1).map_or("fixtures", String::as_str)),
        Some("it") => integrity(args.get(1).map_or("fixtures", String::as_str)),
        Some("serve") => serve(args.get(1).and_then(|p| p.parse().ok()).unwrap_or(4416)),
        _ => eprintln!("usage: botguard-rs probe <dir> | serve [port]"),
    }
}

fn probe(dir: &str) {
    let challenge: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{dir}/challenge.json")).expect("challenge.json"))
            .expect("challenge json");
    let interpreter = std::fs::read_to_string(format!("{dir}/interpreter.js")).expect("interpreter.js");
    let yt_config = std::fs::read_to_string(format!("{dir}/ytcfg.json")).ok();
    let vm = Vm::new(true, yt_config.as_deref()).expect("vm");
    let t0 = Instant::now();
    let snap = vm.snapshot(
        &interpreter,
        challenge["program"].as_str().expect("program"),
        challenge["globalName"].as_str().expect("globalName"),
    );
    match snap {
        Ok(s) => eprintln!("snapshot: {} chars in {:?}, head {}", s.len(), t0.elapsed(), &s[..s.len().min(40)]),
        Err(e) => eprintln!("snapshot failed: {e}"),
    }
    println!("{}", vm.log());
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).user_agent(USER_AGENT).build()
}

fn generate_it(http: &ureq::Agent, snapshot: &str) -> Result<serde_json::Value, String> {
    let mut req = http.post(botguard::GENERATE_IT_URL);
    for (k, v) in botguard::GENERATE_IT_HEADERS {
        req = req.set(k, v);
    }
    req.send_string(&botguard::generate_it_request(snapshot))
        .map_err(|e| format!("GenerateIT: {e}"))?
        .into_json()
        .map_err(|e| e.to_string())
}

/// Snapshot a fixture challenge and ask GenerateIT whether it accepts it.
fn integrity(dir: &str) {
    let challenge: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{dir}/challenge.json")).expect("challenge.json"))
            .expect("challenge json");
    let interpreter = std::fs::read_to_string(format!("{dir}/interpreter.js")).expect("interpreter.js");
    let yt_config = std::fs::read_to_string(format!("{dir}/ytcfg.json")).ok();
    let vm = Vm::new(false, yt_config.as_deref()).expect("vm");
    let snap = vm
        .snapshot(
            &interpreter,
            challenge["program"].as_str().expect("program"),
            challenge["globalName"].as_str().expect("globalName"),
        )
        .expect("snapshot");
    let it = generate_it(&agent(), &snap);
    let accepted = matches!(&it, Ok(v) if v[0].is_string());
    let summary = it.as_ref().map(|v| v.to_string()).unwrap_or_else(|e| e.clone());
    println!("snapshot {} chars -> accepted={accepted} {}", snap.len(), summary.chars().take(120).collect::<String>());
    if let (Ok(v), Ok(id)) = (&it, std::env::var("BG_MINT")) {
        let token = v[0].as_str().unwrap_or_default();
        match vm.minter(token).and_then(|_| vm.mint(&id)) {
            Ok(pot) => println!("pot {} chars: {pot}", pot.len()),
            Err(e) => println!("mint failed: {e}"),
        }
    }
}

struct Server {
    http: ureq::Agent,
    interpreters: HashMap<String, String>,
    /// One attested VM whose minter serves every content binding until the integrity
    /// token's TTL runs out, as bgutil's minter cache does.
    minter: Option<(Vm, Instant)>,
}

fn serve(port: u16) {
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    eprintln!("botguard-rs serving on 127.0.0.1:{port}");
    let mut server = Server {
        http: agent(),
        interpreters: HashMap::new(),
        minter: None,
    };
    for stream in listener.incoming().flatten() {
        if let Err(e) = server.handle(stream) {
            eprintln!("request failed: {e}");
        }
    }
}

impl Server {
    fn handle(&mut self, mut stream: TcpStream) -> Result<(), String> {
        let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| e.to_string())?;
        let mut parts = line.split_whitespace();
        let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let mut len = 0usize;
        loop {
            let mut h = String::new();
            reader.read_line(&mut h).map_err(|e| e.to_string())?;
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                if k.eq_ignore_ascii_case("content-length") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
        }
        let mut body = vec![0u8; len];
        reader.read_exact(&mut body).map_err(|e| e.to_string())?;

        let (status, reply) = match (method, path) {
            ("GET", "/ping") => (200, serde_json::json!({ "version": "botguard-rs" })),
            ("POST", "/get_pot") => match self.get_pot(&body) {
                Ok(v) => (200, v),
                Err(e) => {
                    eprintln!("[get_pot] {e}");
                    (500, serde_json::json!({ "error": e }))
                }
            },
            _ => (404, serde_json::json!({ "error": "not found" })),
        };
        let text = reply.to_string();
        let head = format!(
            "HTTP/1.1 {status} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            if status == 200 { "OK" } else { "ERR" },
            text.len()
        );
        stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(text.as_bytes())).map_err(|e| e.to_string())
    }

    fn get_pot(&mut self, body: &[u8]) -> Result<serde_json::Value, String> {
        let t0 = Instant::now();
        let req: serde_json::Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
        let binding = req["content_binding"].as_str().ok_or("no content_binding")?.to_string();
        if let Some((vm, expiry)) = &self.minter {
            if Instant::now() < *expiry {
                let pot = vm.mint(&binding)?;
                eprintln!("[get_pot] {binding}: cached minter, pot {} chars {:?}", pot.len(), t0.elapsed());
                return Ok(serde_json::json!({ "poToken": pot, "contentBinding": binding }));
            }
        }
        self.minter = None;
        let challenge = req.get("challenge").filter(|c| c.is_object()).ok_or("no page challenge")?;
        let yt_config = req.get("web_config").filter(|c| c.is_object()).map(|c| c.to_string());

        let url = challenge["interpreterUrl"]["privateDoNotAccessOrElseTrustedResourceUrlWrappedValue"]
            .as_str()
            .ok_or("no interpreterUrl")?
            .to_string();
        if !self.interpreters.contains_key(&url) {
            let js = self.http.get(&format!("https:{url}")).call().map_err(|e| e.to_string())?;
            self.interpreters.insert(url.clone(), js.into_string().map_err(|e| e.to_string())?);
        }
        let interpreter = &self.interpreters[&url];
        if let Ok(dir) = std::env::var("BG_DUMP") {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(format!("{dir}/challenge.json"), challenge.to_string());
            let _ = std::fs::write(format!("{dir}/interpreter.js"), interpreter);
            if let Some(c) = &yt_config {
                let _ = std::fs::write(format!("{dir}/ytcfg.json"), c);
            }
        }

        let vm = Vm::new(false, yt_config.as_deref())?;
        let snapshot = vm.snapshot(
            interpreter,
            challenge["program"].as_str().ok_or("no program")?,
            challenge["globalName"].as_str().ok_or("no globalName")?,
        )?;
        let t_snap = t0.elapsed();

        let it = generate_it(&self.http, &snapshot)?;
        let token = it[0].as_str().ok_or_else(|| format!("GenerateIT gave no token: {it}"))?;
        let t_it = t0.elapsed();

        vm.minter(token)?;
        let pot = vm.mint(&binding)?;
        eprintln!(
            "[get_pot] {binding}: snapshot {} chars {:?}, GenerateIT ttl={} {:?}, pot {} chars {:?}",
            snapshot.len(),
            t_snap,
            it[1],
            t_it - t_snap,
            pot.len(),
            t0.elapsed()
        );
        let ttl = Duration::from_secs(it[1].as_u64().unwrap_or(0));
        self.minter = Some((vm, Instant::now() + ttl));
        Ok(serde_json::json!({ "poToken": pot, "contentBinding": binding }))
    }
}
