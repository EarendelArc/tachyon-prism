#[tauri::command]
fn core_status() -> String {
    "disconnected".to_string()
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![core_status])
        .run(tauri::generate_context!())
        .expect("failed to run Tachyon Prism");
}
