use std::io;
#[cfg(not(test))]
use log::error;
#[cfg(not(test))]
use notify_rust::{Notification, Timeout};
use crossterm::{execute};
use crossterm::style::Print;

#[cfg_attr(test, mockall::automock)]
pub trait NotificationHandler {
    fn notify(&self, summary: &str, body: &str);
    fn notify_with_bell(&self, summary: &str, body: &str) {
        self.play_bell();
        self.notify(summary, body);
    }
    fn play_bell(&self) {
        execute!(io::stdout(), Print("\x07")).unwrap();
    }
}

#[cfg(target_os = "linux")]
#[cfg(not(test))]
pub struct LinuxNotificationHandler;

#[cfg(target_os = "linux")]
#[cfg(not(test))]
impl NotificationHandler for LinuxNotificationHandler {
    fn notify(&self, summary: &str, body: &str) {
        use notify_rust::{Hint, Urgency};
        
        if let Err(e) = Notification::new()
            .summary(summary)
            .body(body)
            .timeout(Timeout::Milliseconds(10000))
            .urgency(Urgency::Critical)
            .hint(Hint::SoundName("message-new-instant".to_string()))
            .show()
        {
            error!("Failed to send notification: {}", e);
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[cfg(not(test))]
pub struct DefaultNotificationHandler;

#[cfg(any(target_os = "windows", target_os = "macos"))]
impl NotificationHandler for DefaultNotificationHandler {
    fn notify(&self, summary: &str, body: &str) {
        if let Err(e) = Notification::new()
            .summary(summary)
            .body(body)
            .timeout(Timeout::Milliseconds(10000))
            .show()
        {
            error!("Failed to send notification: {}", e);
        }
    }
}

#[cfg(target_os = "linux")]
#[cfg(not(test))]
pub fn create_notification_handler() -> impl NotificationHandler {
    LinuxNotificationHandler
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[cfg(not(test))]
pub fn create_notification_handler() -> impl NotificationHandler {
    DefaultNotificationHandler
}

#[cfg(test)]
pub fn create_notification_handler() -> impl NotificationHandler {
    MockNotificationHandler::new()
}
