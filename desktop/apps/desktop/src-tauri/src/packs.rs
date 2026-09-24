//! Which characters are available, and which one is showing.
//!
//! The rules for what counts as a pack live in `companion-core`, so they are
//! not written again here: a one-shot Node script reports what it found and
//! this decides what to do with it.
//!
//! Only Marvin ships with the app. The other packs in the repository carry
//! artwork belonging to other people - GitHub's, in Copilot's case - so they
//! are something to point at rather than something to distribute.

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
pub fn discover(script: &Path, bundled: &Path) -> Vec<Pack> {
    let mut command = Command::new("node");
    command.arg(script).arg(bundled);
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

/// Which pack to show: the one chosen last, else the one that shipped.
pub fn choose<'a>(packs: &'a [Pack], wanted: Option<&str>) -> Option<&'a Pack> {
    if let Some(id) = wanted {
        if let Some(found) = packs.iter().find(|pack| pack.id == id) {
            return Some(found);
        }
    }
    // A remembered pack that has since gone should not leave an empty window.
    packs.iter().find(|pack| pack.id == "marvin").or_else(|| packs.first())
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

fn choice_file(window: &tauri::WebviewWindow) -> Option<PathBuf> {
    use tauri::Manager;
    Some(window.app_handle().path().app_data_dir().ok()?.join("character"))
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
        let packs = [pack("marvin"), pack("copilot")];
        assert_eq!(choose(&packs, Some("copilot")).unwrap().id, "copilot");
    }

    /// Pointing at a folder and then moving it should not leave a blank window.
    #[test]
    fn a_pack_that_has_gone_falls_back_rather_than_showing_nothing() {
        let packs = [pack("marvin"), pack("openclaw")];
        assert_eq!(choose(&packs, Some("copilot")).unwrap().id, "marvin");
    }

    #[test]
    fn with_nothing_remembered_the_shipped_one_shows() {
        let packs = [pack("openclaw"), pack("marvin")];
        assert_eq!(choose(&packs, None).unwrap().id, "marvin");
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
