//! Which characters are available, and which one is showing.
//!
//! The rules for what counts as a pack live in `companion-core`, so they are
//! not written again here: a one-shot Node script reports what it found and
//! this decides what to do with it.
//!
//! Copilot, Claude and OpenClaw ship with the app. Anyone else's character is
//! something to point at rather than something to distribute, so it loads from
//! the user's own folder instead.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Pack {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub origin: String,
}

#[derive(Debug, Default, Deserialize)]
struct Found {
    packs: Vec<Pack>,
    #[serde(default)]
    problems: Vec<Problem>,
}

#[derive(Debug, Deserialize)]
struct Problem {
    folder: String,
    reason: String,
}

/// Extra places to look, from the environment.
///
/// A file dialog would be better and is not written yet; this at least means
/// trying another character does not require rebuilding anything.
pub fn extra_folders() -> Vec<String> {
    std::env::var("AGENT_COMPANION_PACKS")
        .unwrap_or_default()
        .split(|c| c == ';' || c == ',')
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

/// Ask the script what is out there. An empty answer is not fatal - the app is
/// still worth having with whatever shipped in it.
pub fn discover(script: &Path, bundled: &Path, extra: &[PathBuf]) -> Vec<Pack> {
    let mut command = Command::new("node");
    command.arg(script).arg(bundled);
    for folder in extra {
        command.arg(folder);
    }
    for folder in extra_folders() {
        command.arg(folder);
    }

    let output = match command.output() {
        Ok(output) => output,
        Err(error) => {
            eprintln!("[packs] could not run the pack search: {error}");
            return Vec::new();
        }
    };

    let found: Found = serde_json::from_slice(&output.stdout).unwrap_or_default();
    for problem in &found.problems {
        println!("[packs] {}: {}", problem.folder, problem.reason);
    }
    println!(
        "[packs] {}",
        if found.packs.is_empty() {
            "none found".to_string()
        } else {
            found
                .packs
                .iter()
                .map(|pack| pack.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        }
    );
    found.packs
}

/// Where the pack search script and the bundled packs are.
///
/// In development the binary lives deep inside `target/`, so the app is found
/// by walking up rather than guessed. A packaged build will resource these
/// properly; this is enough to run.
pub fn locate(relative: &str) -> Option<PathBuf> {
    let mut here = std::env::current_dir().ok()?;
    loop {
        let candidate = here.join("apps").join("desktop").join(relative);
        if candidate.exists() {
            return Some(candidate);
        }
        if !here.pop() {
            return None;
        }
    }
}

/// The character shown before anyone picks one, and the one the app icon wears.
/// Kept in step with `DEFAULT_PACK` in `esbuild.mjs`, which bundles it.
const DEFAULT_PACK: &str = "copilot";

/// Which pack to show: the one chosen last, else the one that shipped.
pub fn choose<'a>(packs: &'a [Pack], wanted: Option<&str>) -> Option<&'a Pack> {
    if let Some(id) = wanted {
        if let Some(found) = packs.iter().find(|pack| pack.id == id) {
            return Some(found);
        }
    }
    // A remembered pack that has since gone should not leave an empty window.
    packs.iter().find(|pack| pack.id == DEFAULT_PACK).or_else(|| packs.first())
}


/// The character last chosen, so it is still there next time.
///
/// Its own small file rather than a field alongside the window position: the
/// position is written on every step of a drag, and a read-modify-write on each
/// of those to preserve one string is more moving parts than two files.
pub fn remembered(window: &tauri::WebviewWindow) -> Option<String> {
    let path = choice_file(window)?;
    std::fs::read_to_string(path).ok().map(|id| id.trim().to_string()).filter(|id| !id.is_empty())
}

pub fn remember(window: &tauri::WebviewWindow, id: &str) {
    let Some(path) = choice_file(window) else { return };
    if let Some(directory) = path.parent() {
        let _ = std::fs::create_dir_all(directory);
    }
    let _ = std::fs::write(path, id);
}

/// A folder of the user's own, always looked in.
///
/// Only three characters ship, so without somewhere obvious to put your own
/// there is no way to see it in the Character menu. An environment variable is
/// not somewhere obvious. This is.
pub fn user_folder(window: &tauri::WebviewWindow) -> Option<PathBuf> {
    use tauri::Manager;
    let folder = window.app_handle().path().app_data_dir().ok()?.join("packs");
    // Made on the way past, so the menu item that opens it always has something
    // to open, and so it is discoverable before anyone has a pack to put in it.
    let _ = std::fs::create_dir_all(&folder);
    Some(folder)
}

/// Show a folder to the person, in whatever their system uses for the job.
pub fn reveal(folder: &Path) {
    let opener = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    // explorer returns a non-zero code even when it worked, so the result is
    // deliberately not checked.
    let _ = Command::new(opener).arg(folder).spawn();
}
fn choice_file(window: &tauri::WebviewWindow) -> Option<PathBuf> {
    use tauri::Manager;
    Some(window.app_handle().path().app_data_dir().ok()?.join("character"))
}
/// The URL space packs are served in.
///
/// A protocol of our own rather than Tauri's asset one, which URL-encodes the
/// whole file path - leaving no separator for the renderer to resolve image
/// names against, so every pack outside the app tried to load its art from the
/// root. Here a pack is a folder in a URL, relative resolution works the way
/// the renderer already expects, and nothing needs a scope opening for it.
pub const SCHEME: &str = "pack";

/// Where a pack's manifest lives, as the page should ask for it.
pub fn manifest_url(id: &str) -> String {
    // Windows serves custom schemes over http; everywhere else uses the scheme.
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/{id}/pack.json")
    } else {
        format!("{SCHEME}://localhost/{id}/pack.json")
    }
}

/// Resolve a request path to a file inside a known pack, or nothing.
///
/// Only the packs found at startup can be reached, and only within them: the
/// pack id must match one exactly, and the rest must stay inside its folder
/// once resolved, so no amount of dot-dot reaches anything else.
pub fn resolve(packs: &[Pack], path: &str) -> Option<PathBuf> {
    let trimmed = path.trim_start_matches('/');
    let (id, rest) = trimmed.split_once('/')?;
    // A backslash would be a separator on Windows and a filename elsewhere;
    // refusing it outright keeps one meaning on every platform.
    if rest.is_empty() || rest.contains('\\') {
        return None;
    }

    let pack = packs.iter().find(|pack| pack.id == id)?;
    let folder = PathBuf::from(&pack.folder);
    let wanted = folder.join(rest);

    // Compare what the filesystem makes of both, so a traversal that survived
    // the textual check does not survive this one.
    let root = folder.canonicalize().ok()?;
    let target = wanted.canonicalize().ok()?;
    target.starts_with(&root).then_some(target)
}

/// What to call a file, so the page treats it as it should.
pub fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|it| it.to_str()) {
        Some("json") => "application/json",
        Some("webp") => "image/webp",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn pack(id: &str) -> Pack {
        Pack {
            id: id.to_string(),
            name: id.to_string(),
            folder: format!("/packs/{id}"),
            origin: "configured".to_string(),
        }
    }

    #[test]
    fn the_chosen_one_wins() {
        let packs = [pack("copilot"), pack("claude")];
        assert_eq!(choose(&packs, Some("claude")).unwrap().id, "claude");
    }

    /// Pointing at a folder and then moving it should not leave a blank window.
    #[test]
    fn a_pack_that_has_gone_falls_back_rather_than_showing_nothing() {
        let packs = [pack("copilot"), pack("openclaw")];
        assert_eq!(choose(&packs, Some("arthur")).unwrap().id, "copilot");
    }

    /// The shipped default wins over a pack that merely sorts earlier.
    #[test]
    fn with_nothing_remembered_the_shipped_one_shows() {
        let packs = [pack("claude"), pack("copilot")];
        assert_eq!(choose(&packs, None).unwrap().id, "copilot");
    }

    #[test]
    fn without_even_that_the_first_one_will_do() {
        let packs = [pack("openclaw")];
        assert_eq!(choose(&packs, None).unwrap().id, "openclaw");
        assert!(choose(&[], None).is_none());
    }

    #[test]
    fn extra_folders_are_split_on_either_separator() {
        // Windows paths contain colons, so the separator is not a colon.
        unsafe { std::env::set_var("AGENT_COMPANION_PACKS", r"C:\packs; D:\more ,") };
        assert_eq!(extra_folders(), vec![r"C:\packs".to_string(), r"D:\more".to_string()]);
        unsafe { std::env::remove_var("AGENT_COMPANION_PACKS") };
    }
}
