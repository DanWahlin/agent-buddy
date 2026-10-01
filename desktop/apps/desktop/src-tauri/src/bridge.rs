//! The Node half: the endpoint, the coordinators, the routing.
//!
//! None of that is reimplemented here. It is already written and already
//! tested on three platforms, and `node` is a prerequisite of the whole system
//! anyway - the hooks the agents run are `node hook.js`, and the installer
//! refuses without it. So the same code runs in a child process and this talks
//! to it in newline-delimited JSON.
//!
//! Everything about that is deliberately replaceable: nothing below depends on
//! the other end being Node, only on the lines it writes.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::{Emitter, WebviewWindow};

pub struct Bridge {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

/// Where the bridge process lives, relative to this binary or the source tree.
///
/// In development the binary sits deep inside `target/`, so the workspace is
/// found by walking up rather than guessed. A packaged build will resource it
/// properly; this is enough to run and to test.
fn host_script() -> Option<PathBuf> {
    let mut here = std::env::current_dir().ok()?;
    loop {
        let candidate = here
            .join("packages")
            .join("agent-state")
            .join("dist")
            .join("host.js");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !here.pop() {
            return None;
        }
    }
}

impl Bridge {
    pub fn spawn(window: WebviewWindow) -> Result<Self, String> {
        let script = host_script().ok_or_else(|| {
            "could not find packages/agent-state/dist/host.js - has the workspace been built?"
                .to_string()
        })?;

        let mut child = Command::new("node")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("could not run node: {error}"))?;

        let stdout = child.stdout.take().ok_or("no stdout from the bridge")?;
        let stdin = child.stdin.take().ok_or("no stdin to the bridge")?;

        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                match message.get("type").and_then(|value| value.as_str()) {
                    // The only thing the page needs from all this.
                    Some("state") => {
                        if let Some(state) = message.get("state").and_then(|v| v.as_str()) {
                            // Said out loud because it is otherwise invisible:
                            // the page is the only thing that shows it, and a
                            // page that is not drawing looks the same as a
                            // bridge that is not sending.
                            println!("[state] {state}");
                            let _ = window.emit(
                                "to-view",
                                serde_json::json!({ "type": "state", "state": state }),
                            );
                        }
                    }
                    Some("ready") => println!("[bridge] {line}"),
                    Some("log") | Some("stopping") | Some("fatal") => println!("[bridge] {line}"),
                    _ => {}
                }
            }
        });

        Ok(Self {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
        })
    }

    pub fn send(&self, message: &serde_json::Value) {
        if let Some(stdin) = self.stdin.lock().unwrap().as_mut() {
            let _ = writeln!(stdin, "{message}");
            let _ = stdin.flush();
        }
    }

    /// Ask it to stop, and let it.
    ///
    /// Killing it would leave the endpoint held until the OS got round to it,
    /// and the other windows waiting to take over. So: say stop, drop stdin so
    /// it hears the parent leaving even if it missed that, then wait briefly.
    /// Only if it is still there after that is it killed.
    pub fn stop(&self) {
        self.send(&serde_json::json!({ "type": "stop" }));
        drop(self.stdin.lock().unwrap().take());

        let Some(mut child) = self.child.lock().unwrap().take() else { return };
        for _ in 0..40 {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = child.kill();
    }
}
