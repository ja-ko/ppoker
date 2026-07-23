use std::collections::VecDeque;

use ppoker_core::client::TransportEvent;

// Retain at most 1,024 callback events and 1 MiB of UTF-8 text. A single
// terminal overflow marker is stored separately so accepted events drain first.
pub(crate) const MAX_QUEUED_EVENTS: usize = 1024;
pub(crate) const MAX_QUEUED_TEXT_BYTES: usize = 1024 * 1024;
pub(crate) const QUEUE_OVERFLOW_ERROR: &str = "Browser WebSocket event queue limit exceeded.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PushResult {
    Queued,
    Overflowed,
    Stopped,
}

#[derive(Default)]
pub(crate) struct EventQueue {
    events: VecDeque<TransportEvent>,
    queued_text_bytes: usize,
    overflow_error: Option<String>,
    stopped: bool,
}

impl EventQueue {
    pub(crate) fn is_stopped(&self) -> bool {
        self.stopped
    }

    pub(crate) fn push(&mut self, event: TransportEvent) -> PushResult {
        if self.stopped {
            return PushResult::Stopped;
        }

        let text_bytes = match &event {
            TransportEvent::Text(text) => text.len(),
            _ => 0,
        };
        let exceeds_text_budget = self
            .queued_text_bytes
            .checked_add(text_bytes)
            .is_none_or(|bytes| bytes > MAX_QUEUED_TEXT_BYTES);
        if self.events.len() >= MAX_QUEUED_EVENTS || exceeds_text_budget {
            return self.overflow();
        }

        let terminal = matches!(event, TransportEvent::Closed | TransportEvent::Error(_));
        self.queued_text_bytes += text_bytes;
        self.events.push_back(event);
        self.stopped = terminal;
        PushResult::Queued
    }

    pub(crate) fn overflow(&mut self) -> PushResult {
        if self.stopped {
            return PushResult::Stopped;
        }
        self.stopped = true;
        self.overflow_error = Some(QUEUE_OVERFLOW_ERROR.to_string());
        PushResult::Overflowed
    }

    pub(crate) fn pop(&mut self) -> Option<TransportEvent> {
        if let Some(event) = self.events.pop_front() {
            if let TransportEvent::Text(text) = &event {
                self.queued_text_bytes -= text.len();
            }
            Some(event)
        } else {
            self.overflow_error.take().map(TransportEvent::Error)
        }
    }

    pub(crate) fn clear(&mut self) {
        self.events.clear();
        self.queued_text_bytes = 0;
        self.overflow_error = None;
        self.stopped = true;
    }
}

#[cfg(test)]
mod tests;
