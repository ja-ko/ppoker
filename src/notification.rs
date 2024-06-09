use log::error;
#[cfg(target_os = "linux")]
use notify_rust::{Hint, Urgency};
use notify_rust::{Notification, Timeout};

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn show_notification() {
    if let Err(e) = Notification::new()
        .summary("Planning Poker")
        .body("Your vote is the last one missing.")
        .timeout(Timeout::Milliseconds(10000))
        .show() {
        error!("Failed to send notification: {}", e);
    }
}

#[cfg(target_os = "linux")]
pub fn show_notification() {
    if let Err(e) = Notification::new()
        .summary("Planning Poker")
        .body("Your vote is the last one missing.")
        .timeout(Timeout::Milliseconds(10000))
        .urgency(Urgency::Critical)
        .hint(Hint::SoundName("message-new-instant".to_string()))
        .show() {
        error!("Failed to send notification: {}", e);
    }
}

