#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if tachyon_prism_lib::run_core_parent_watchdog_if_requested() {
        return;
    }
    tachyon_prism_lib::run()
}
