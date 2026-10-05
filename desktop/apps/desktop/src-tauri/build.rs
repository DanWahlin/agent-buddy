fn main() {
    // The page is embedded at compile time; a change to it alone must rebuild.
    println!("cargo:rerun-if-changed=../ui");
    // The app tells the companion service which release it is, so Settings can show both versions.
    // Release builds also set the bundle version from this file; a local build keeps tauri.conf.json's.
    let version_file = std::path::Path::new("../../../../VERSION");
    println!("cargo:rerun-if-changed={}", version_file.display());
    let version = std::fs::read_to_string(version_file)
        .map(|it| it.trim().to_string())
        .ok()
        .filter(|it| !it.is_empty())
        .unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").unwrap());
    println!("cargo:rustc-env=AGENT_COMPANION_VERSION={version}");
    tauri_build::build()
}
