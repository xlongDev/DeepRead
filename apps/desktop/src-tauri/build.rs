fn main() {
    // tauri-build doesn't track the dist dir: a `pnpm build` without this line
    // leaves the binary serving its previously embedded (stale) frontend.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
