//! BotGuard in QuickJS: attest a page challenge and mint WebPO tokens, with no I/O.
//!
//! The caller fetches the interpreter script and calls GenerateIT itself; see
//! [`generate_it_request`] and [`parse_generate_it`] for the wire shapes.

mod vm;

use std::sync::mpsc;
use std::time::Duration;

pub use vm::Vm;

/// Request key the web client sends with every GenerateIT call.
pub const REQUEST_KEY: &str = "O43z0dpjhgX20SCx4KAo";
/// API key the web client sends in `x-goog-api-key` to GenerateIT.
pub const GOOG_API_KEY: &str = "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw";
pub const GENERATE_IT_URL: &str = "https://www.youtube.com/api/jnn/v1/GenerateIT";

/// Headers GenerateIT expects, besides the user agent.
pub const GENERATE_IT_HEADERS: [(&str, &str); 3] = [
    ("content-type", "application/json+protobuf"),
    ("x-goog-api-key", GOOG_API_KEY),
    ("x-user-agent", "grpc-web-javascript/0.1"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The challenge JSON lacks a field the VM needs.
    Challenge(&'static str),
    /// The VM threw, or a stage did not finish in time.
    Vm(String),
    /// GenerateIT answered without an integrity token: it refused the snapshot.
    Refused(String),
    /// The minting thread is gone.
    Closed,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Challenge(what) => write!(f, "challenge has no {what}"),
            Error::Vm(e) => write!(f, "botguard vm: {e}"),
            Error::Refused(body) => write!(f, "GenerateIT refused the snapshot: {body}"),
            Error::Closed => write!(f, "botguard thread stopped"),
        }
    }
}

impl std::error::Error for Error {}

/// The parts of a page `bgChallenge` the VM runs.
#[derive(Debug, Clone)]
pub struct Challenge {
    pub interpreter_url: String,
    pub program: String,
    pub global_name: String,
}

impl Challenge {
    /// Read a page `bgChallenge` (raw JSON). `interpreter_url` comes back absolute.
    pub fn parse(challenge_json: &str) -> Result<Self, Error> {
        let v: serde_json::Value = serde_json::from_str(challenge_json).map_err(|_| Error::Challenge("valid JSON"))?;
        let url = v["interpreterUrl"]["privateDoNotAccessOrElseTrustedResourceUrlWrappedValue"]
            .as_str()
            .ok_or(Error::Challenge("interpreterUrl"))?;
        Ok(Self {
            interpreter_url: if url.starts_with("//") { format!("https:{url}") } else { url.to_string() },
            program: v["program"].as_str().ok_or(Error::Challenge("program"))?.to_string(),
            global_name: v["globalName"].as_str().ok_or(Error::Challenge("globalName"))?.to_string(),
        })
    }
}

/// GenerateIT request body for a snapshot.
pub fn generate_it_request(snapshot: &str) -> String {
    serde_json::json!([REQUEST_KEY, snapshot]).to_string()
}

/// An integrity token and how long GenerateIT says it lives.
#[derive(Debug, Clone)]
pub struct IntegrityToken {
    pub token: String,
    pub ttl: Duration,
}

/// Parse a GenerateIT response; [`Error::Refused`] when it carries no token.
pub fn parse_generate_it(body: &str) -> Result<IntegrityToken, Error> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|_| Error::Refused(body.chars().take(200).collect()))?;
    let token = v[0].as_str().ok_or_else(|| Error::Refused(body.chars().take(200).collect()))?;
    Ok(IntegrityToken { token: token.to_string(), ttl: Duration::from_secs(v[1].as_u64().unwrap_or(0)) })
}

enum Job {
    Snapshot { interpreter: String, challenge: Challenge, yt_config: Option<String>, reply: mpsc::Sender<Result<String, Error>> },
    Install { token: String, reply: mpsc::Sender<Result<(), Error>> },
    Mint { identifier: String, reply: mpsc::Sender<Result<String, Error>> },
}

/// A BotGuard VM on its own thread (QuickJS contexts are `!Send`): snapshot -> GenerateIT
/// (caller) -> install -> mint per binding. A new snapshot replaces the VM and its minter.
#[derive(Clone)]
pub struct BotGuard {
    tx: mpsc::Sender<Job>,
}

impl Default for BotGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl BotGuard {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("botguard".into())
            .spawn(move || {
                let mut vm: Option<Vm> = None;
                while let Ok(job) = rx.recv() {
                    match job {
                        Job::Snapshot { interpreter, challenge, yt_config, reply } => {
                            vm = None;
                            let r = Vm::new(false, yt_config.as_deref()).and_then(|v| {
                                let s = v.snapshot(&interpreter, &challenge.program, &challenge.global_name)?;
                                vm = Some(v);
                                Ok(s)
                            });
                            let _ = reply.send(r.map_err(Error::Vm));
                        }
                        Job::Install { token, reply } => {
                            let r = match &vm {
                                Some(v) => v.minter(&token).map_err(Error::Vm),
                                None => Err(Error::Vm("no snapshot taken".into())),
                            };
                            let _ = reply.send(r);
                        }
                        Job::Mint { identifier, reply } => {
                            let r = match &vm {
                                Some(v) => v.mint(&identifier).map_err(Error::Vm),
                                None => Err(Error::Vm("no minter installed".into())),
                            };
                            let _ = reply.send(r);
                        }
                    }
                }
            })
            .expect("spawn botguard thread");
        Self { tx }
    }

    fn ask<T>(&self, make: impl FnOnce(mpsc::Sender<Result<T, Error>>) -> Job) -> Result<T, Error> {
        let (reply, rx) = mpsc::channel();
        self.tx.send(make(reply)).map_err(|_| Error::Closed)?;
        rx.recv().map_err(|_| Error::Closed)?
    }

    /// Run the challenge's program in a fresh VM and return the attestation snapshot.
    /// `yt_config` is the page's `ytcfg` JSON, installed as `window.yt.config_`. Blocking.
    pub fn snapshot(&self, interpreter: String, challenge: Challenge, yt_config: Option<String>) -> Result<String, Error> {
        self.ask(|reply| Job::Snapshot { interpreter, challenge, yt_config, reply })
    }

    /// Hand GenerateIT's integrity token to the VM's minter. Blocking.
    pub fn install(&self, integrity_token: String) -> Result<(), Error> {
        self.ask(|reply| Job::Install { token: integrity_token, reply })
    }

    /// Mint a PO token (base64url) for `identifier`, e.g. a video id. Blocking, ~ms.
    pub fn mint(&self, identifier: String) -> Result<String, Error> {
        self.ask(|reply| Job::Mint { identifier, reply })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_url_becomes_absolute() {
        let c = Challenge::parse(
            r#"{"interpreterUrl":{"privateDoNotAccessOrElseTrustedResourceUrlWrappedValue":"//www.google.com/js/th/x.js"},"program":"p","globalName":"g"}"#,
        )
        .unwrap();
        assert_eq!(c.interpreter_url, "https://www.google.com/js/th/x.js");
        assert_eq!((c.program.as_str(), c.global_name.as_str()), ("p", "g"));
    }

    #[test]
    fn refused_generate_it_is_an_error() {
        assert!(matches!(parse_generate_it(r#"[null,43200,null,"fallback"]"#), Err(Error::Refused(_))));
        let ok = parse_generate_it(r#"["tok",43200,100]"#).unwrap();
        assert_eq!((ok.token.as_str(), ok.ttl.as_secs()), ("tok", 43200));
    }
}
