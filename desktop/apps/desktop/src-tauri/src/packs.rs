//! Which character to show, as the `.acpk` pack the device itself installs.
//!
//! The desktop draws with the firmware's engine, so it reads the firmware's
//! packs. When the ESP32 daemon is running it says which character and which
//! file, so the desktop and the device always agree; without it the app falls
//! back to the packs built in this repository (`build/characters`).

use std::path::{Path, PathBuf};

/// The character shown when nothing says otherwise.
pub const DEFAULT: &str = "copilot";

/// The URL scheme the page fetches the pack from.
pub const SCHEME: &str = "pack";

/// A character id as the daemon and the firmware accept one.
pub fn is_valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some('a'..='z'))
        && id.len() <= 16
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The repository's built packs, found by walking up from where the app runs.
pub fn built_in_directory() -> Option<PathBuf> {
    let mut here = std::env::current_dir().ok()?;
    loop {
        let candidate = here.join("build").join("characters");
        if candidate.is_dir() {
            return Some(candidate);
        }
        if !here.pop() {
            return None;
        }
    }
}

/// The ids of the packs in a directory, the default first.
pub fn list(directory: &Path) -> Vec<String> {
    let mut ids: Vec<String> = std::fs::read_dir(directory)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .filter_map(|name| name.strip_suffix(".acpk").map(str::to_string))
                .filter(|id| is_valid_id(id))
                .collect()
        })
        .unwrap_or_default();
    ids.sort_by(|a, b| (a != DEFAULT, a).cmp(&(b != DEFAULT, b)));
    ids
}

/// Where a pack lives, if it does.
pub fn path_for(directory: &Path, id: &str) -> Option<PathBuf> {
    if !is_valid_id(id) {
        return None;
    }
    let path = directory.join(format!("{id}.acpk"));
    path.is_file().then_some(path)
}

/// Which pack to show without the daemon: the one chosen last, else the default.
pub fn choose<'a>(ids: &'a [String], wanted: Option<&str>) -> Option<&'a String> {
    wanted
        .and_then(|id| ids.iter().find(|candidate| candidate.as_str() == id))
        .or_else(|| ids.iter().find(|candidate| candidate.as_str() == DEFAULT))
        .or_else(|| ids.first())
}

/// Where the page fetches a pack from.
pub fn pack_url(id: &str) -> String {
    // Windows serves custom schemes over http; everywhere else uses the scheme.
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/{id}.acpk")
    } else {
        format!("{SCHEME}://localhost/{id}.acpk")
    }
}

/// The id a request asks for, from its path.
pub fn requested_id(path: &str) -> Option<&str> {
    let id = path.trim_start_matches('/').strip_suffix(".acpk")?;
    is_valid_id(id).then_some(id)
}

/// The character last chosen from the tray, for when there is no daemon.
pub fn remembered(window: &tauri::WebviewWindow) -> Option<String> {
    let path = choice_file(window)?;
    std::fs::read_to_string(path)
        .ok()
        .map(|id| id.trim().to_string())
        .filter(|id| is_valid_id(id))
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

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn ids_follow_the_firmware_rules() {
        assert!(is_valid_id("copilot"));
        assert!(is_valid_id("my-agent2"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("2fast"));
        assert!(!is_valid_id("Copilot"));
        assert!(!is_valid_id("../etc"));
        assert!(!is_valid_id("a-name-far-too-long"));
    }

    #[test]
    fn the_chosen_one_wins_then_the_default_then_anything() {
        let all = ids(&["copilot", "claude", "openclaw"]);
        assert_eq!(choose(&all, Some("claude")).unwrap(), "claude");
        assert_eq!(choose(&all, Some("gone")).unwrap(), "copilot");
        assert_eq!(choose(&all, None).unwrap(), "copilot");
        assert_eq!(choose(&ids(&["openclaw"]), None).unwrap(), "openclaw");
        assert!(choose(&[], None).is_none());
    }

    #[test]
    fn only_a_plain_pack_name_can_be_requested() {
        assert_eq!(requested_id("/copilot.acpk"), Some("copilot"));
        assert_eq!(requested_id("/../copilot.acpk"), None);
        assert_eq!(requested_id("/copilot/pack.json"), None);
        assert_eq!(requested_id("/copilot"), None);
    }

    #[test]
    fn the_built_packs_are_listed_default_first() {
        let directory = std::env::temp_dir().join(format!("ac-packs-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        for name in ["openclaw.acpk", "copilot.acpk", "claude.acpk", "notes.txt", "Bad.acpk"] {
            std::fs::write(directory.join(name), b"x").unwrap();
        }
        assert_eq!(list(&directory), ids(&["copilot", "claude", "openclaw"]));
        assert!(path_for(&directory, "claude").is_some());
        assert!(path_for(&directory, "nobody").is_none());
        let _ = std::fs::remove_dir_all(&directory);
    }
}
