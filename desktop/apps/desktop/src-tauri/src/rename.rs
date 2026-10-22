//! The app was named Agent Companion before it became Agent Buddy. The product
//! name sets where the app is installed, so a new name is a new install.
//! Windows (the installer's hook in `windows/hooks.nsh`) and Linux (the
//! `.deb`'s Conflicts and Replaces) remove the old install when the new one is
//! installed. On macOS, a dragged-in app runs no installer, so the app removes
//! the old bundle itself the first time it runs under the new name.

use std::path::{Path, PathBuf};

/// The bundle that versions before the rename installed.
pub const OLD_BUNDLE: &str = "Agent Companion.app";

/// The old bundles to remove: those in the install folders that carry this
/// app's identifier. Only an installed app removes them, so a build run from
/// the repository leaves installed apps alone.
pub fn old_bundles(running: &Path, folders: &[PathBuf], identifier: &str) -> Vec<PathBuf> {
    if !folders.iter().any(|folder| running.parent() == Some(folder.as_path())) {
        return Vec::new();
    }
    folders
        .iter()
        .map(|folder| folder.join(OLD_BUNDLE))
        .filter(|bundle| bundle != running && bundle_identifier(bundle).as_deref() == Some(identifier))
        .collect()
}

/// `CFBundleIdentifier` from a bundle's Info.plist, which Tauri writes as XML.
fn bundle_identifier(bundle: &Path) -> Option<String> {
    let text = std::fs::read_to_string(bundle.join("Contents").join("Info.plist")).ok()?;
    let after = text.split("<key>CFBundleIdentifier</key>").nth(1)?;
    let value = after.trim_start().strip_prefix("<string>")?;
    Some(value.split("</string>").next()?.trim().to_string())
}

/// Removes an Agent Companion bundle that this app, now Agent Buddy, replaces.
#[cfg(target_os = "macos")]
pub fn remove_old_bundle(identifier: &str) {
    let Some(running) = std::env::current_exe().ok().and_then(|it| crate::daemon::app_bundle(&it)) else {
        return;
    };
    let mut folders = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        folders.push(PathBuf::from(home).join("Applications"));
    }
    for old in old_bundles(&running, &folders, identifier) {
        match std::fs::remove_dir_all(&old) {
            Ok(()) => println!("[rename] removed {}, which this app replaces", old.display()),
            Err(error) => eprintln!("[rename] could not remove {}: {error}", old.display()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "dev.agentcompanion.desktop";

    fn bundle(folder: &Path, name: &str, identifier: &str) -> PathBuf {
        let bundle = folder.join(name);
        std::fs::create_dir_all(bundle.join("Contents")).unwrap();
        std::fs::write(
            bundle.join("Contents").join("Info.plist"),
            format!("<plist><dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>{identifier}</string>\n</dict></plist>"),
        )
        .unwrap();
        bundle
    }

    #[test]
    fn the_renamed_app_removes_only_its_own_old_bundle() {
        let root = std::env::temp_dir().join(format!("ac-rename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (system, user) = (root.join("Applications"), root.join("home").join("Applications"));
        std::fs::create_dir_all(&system).unwrap();
        std::fs::create_dir_all(&user).unwrap();
        let folders = [system.clone(), user.clone()];
        let running = bundle(&system, "Agent Buddy.app", ID);
        let old = bundle(&system, OLD_BUNDLE, ID);
        // An app of another maker with the old name stays.
        bundle(&user, OLD_BUNDLE, "com.example.other");
        assert_eq!(old_bundles(&running, &folders, ID), vec![old.clone()]);

        // A build run from the repository removes nothing.
        let build = bundle(&root.join("target"), "Agent Buddy.app", ID);
        assert!(old_bundles(&build, &folders, ID).is_empty());
        // Nor does an app that still has the old name, or a bundle without an Info.plist.
        assert!(old_bundles(&old, &folders, ID).is_empty());
        std::fs::remove_file(old.join("Contents").join("Info.plist")).unwrap();
        assert!(old_bundles(&running, &folders, ID).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
