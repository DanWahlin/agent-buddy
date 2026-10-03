fn main() {
    // The page is embedded at compile time; a change to it alone must rebuild.
    println!("cargo:rerun-if-changed=../ui");
    tauri_build::build()
}
